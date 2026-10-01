// LoL rank tracker: polls the Riot API on an interval, stores LP snapshots, serves the dashboard.
// Zero dependencies — needs Node 22.9+ (built-in fetch and --env-file-if-exists).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const API_KEY = process.env.RIOT_API_KEY || '';
const PORT = Number(process.env.PORT) || 3000;
const POLL_MINUTES = Math.max(1, Number(process.env.POLL_MINUTES) || 5);
const DEFAULT_REGION = process.env.DEFAULT_REGION || 'euw1';

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// Platform routing value -> regional routing value (account-v1 only lives on americas/asia/europe).
const REGIONS = {
  euw1: 'europe', eun1: 'europe', tr1: 'europe', ru: 'europe', me1: 'europe',
  na1: 'americas', br1: 'americas', la1: 'americas', la2: 'americas',
  kr: 'asia', jp1: 'asia',
  oc1: 'asia', sg2: 'asia', tw2: 'asia', vn2: 'asia',
};
const QUEUES = ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'];
const PALETTE_SLOTS = 8;

// ---------- storage ----------

function loadDb() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    return { players: [] };
  }
}

let db = loadDb();

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

// ---------- Riot API ----------

class RiotError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function riot(url, attempt = 0) {
  if (!API_KEY) throw new RiotError(500, 'RIOT_API_KEY is not set. Add it to .env and restart.');
  const res = await fetch(url, { headers: { 'X-Riot-Token': API_KEY } });
  if (res.status === 429 && attempt < 3) {
    const wait = (Number(res.headers.get('retry-after')) || 2) * 1000;
    await new Promise((r) => setTimeout(r, wait));
    return riot(url, attempt + 1);
  }
  if (!res.ok) {
    const messages = {
      401: 'Riot API key missing or invalid.',
      403: 'Riot API key rejected — development keys expire every 24h, regenerate it at developer.riotgames.com.',
      404: 'Not found.',
    };
    throw new RiotError(res.status, messages[res.status] || `Riot API error ${res.status}`);
  }
  return res.json();
}

const enc = encodeURIComponent;

async function lookupAccount(gameName, tagLine, region) {
  const regional = REGIONS[region];
  return riot(`https://${regional}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${enc(gameName)}/${enc(tagLine)}`);
}

async function fetchSummoner(puuid, region) {
  return riot(`https://${region}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${enc(puuid)}`);
}

async function fetchEntries(puuid, region) {
  return riot(`https://${region}.api.riotgames.com/lol/league/v4/entries/by-puuid/${enc(puuid)}`);
}

// ---------- tracking ----------

function parseRiotId(input) {
  const [gameName, tagLine] = String(input || '').split('#').map((s) => s.trim());
  if (!gameName || !tagLine) return null;
  return { gameName, tagLine };
}

function nextColorSlot() {
  const used = new Set(db.players.map((p) => p.color));
  for (let i = 0; i < PALETTE_SLOTS; i++) if (!used.has(i)) return i;
  return db.players.length % PALETTE_SLOTS;
}

// Appends a snapshot per queue only when something changed, so history stays compact.
function recordEntries(player, entries, now) {
  for (const queue of QUEUES) {
    const e = entries.find((x) => x.queueType === queue);
    if (!e) continue;
    const snap = { t: now, tier: e.tier, rank: e.rank, lp: e.leaguePoints, wins: e.wins, losses: e.losses };
    const hist = (player.history[queue] ||= []);
    const last = hist[hist.length - 1];
    const changed = !last || ['tier', 'rank', 'lp', 'wins', 'losses'].some((k) => last[k] !== snap[k]);
    if (changed) hist.push(snap);
  }
  player.lastChecked = now;
  player.error = null;
}

async function pollPlayer(player) {
  let entries;
  try {
    entries = await fetchEntries(player.puuid, player.region);
  } catch (err) {
    // PUUIDs are encrypted per API key project; re-resolve from the Riot ID if the key changed.
    if (err.status !== 400 && err.status !== 404) throw err;
    const acct = await lookupAccount(player.gameName, player.tagLine, player.region);
    player.puuid = acct.puuid;
    entries = await fetchEntries(player.puuid, player.region);
  }
  recordEntries(player, entries, Date.now());
}

let polling = false;
let lastPoll = null;

async function pollAll() {
  if (polling) return;
  polling = true;
  try {
    for (const player of db.players) {
      try {
        await pollPlayer(player);
      } catch (err) {
        player.error = err.message;
        console.error(`[poll] ${player.gameName}#${player.tagLine}: ${err.message}`);
      }
    }
    lastPoll = Date.now();
    saveDb();
  } finally {
    polling = false;
  }
}

async function addPlayer(riotId, region) {
  const id = parseRiotId(riotId);
  if (!id) throw new RiotError(400, 'Use the full Riot ID, e.g. "Faker#KR1".');
  if (!REGIONS[region]) throw new RiotError(400, `Unknown region "${region}".`);

  let acct;
  try {
    acct = await lookupAccount(id.gameName, id.tagLine, region);
  } catch (err) {
    if (err.status === 404) throw new RiotError(404, `No account named ${id.gameName}#${id.tagLine}.`);
    throw err;
  }
  if (db.players.some((p) => p.puuid === acct.puuid)) {
    throw new RiotError(409, `${acct.gameName}#${acct.tagLine} is already tracked.`);
  }

  const [summoner, entries] = await Promise.all([fetchSummoner(acct.puuid, region), fetchEntries(acct.puuid, region)]);
  const player = {
    puuid: acct.puuid,
    gameName: acct.gameName,
    tagLine: acct.tagLine,
    region,
    profileIconId: summoner.profileIconId,
    summonerLevel: summoner.summonerLevel,
    color: nextColorSlot(),
    addedAt: Date.now(),
    lastChecked: null,
    error: null,
    history: {},
  };
  recordEntries(player, entries, Date.now());
  db.players.push(player);
  saveDb();
  return player;
}

// ---------- HTTP ----------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new RiotError(400, 'Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/state' && req.method === 'GET') {
      return send(res, 200, {
        players: db.players,
        lastPoll,
        polling,
        pollMinutes: POLL_MINUTES,
        apiKeySet: Boolean(API_KEY),
        defaultRegion: DEFAULT_REGION,
        regions: Object.keys(REGIONS),
      });
    }
    if (pathname === '/api/players' && req.method === 'POST') {
      const body = await readBody(req);
      const player = await addPlayer(body.riotId, body.region || DEFAULT_REGION);
      return send(res, 201, player);
    }
    const del = pathname.match(/^\/api\/players\/([^/]+)$/);
    if (del && req.method === 'DELETE') {
      const puuid = decodeURIComponent(del[1]);
      const before = db.players.length;
      db.players = db.players.filter((p) => p.puuid !== puuid);
      if (db.players.length === before) return send(res, 404, { error: 'Player not found.' });
      saveDb();
      return send(res, 200, { ok: true });
    }
    if (pathname === '/api/refresh' && req.method === 'POST') {
      await pollAll();
      return send(res, 200, { ok: true });
    }
    if (pathname.startsWith('/api/')) return send(res, 404, { error: 'Not found' });
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    send(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    send(res, err.status && err.status < 600 ? err.status : 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`Rank tracker running at http://localhost:${PORT}`);
  if (!API_KEY) console.warn('Warning: RIOT_API_KEY is not set — copy .env.example to .env and add your key.');
  console.log(`Polling ${db.players.length} player(s) every ${POLL_MINUTES} min.`);
  pollAll();
  setInterval(pollAll, POLL_MINUTES * 60 * 1000);
});
