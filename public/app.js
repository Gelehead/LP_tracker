// Dashboard: fetches /api/state, renders player cards, the LP chart and the rank-change log.
const TIERS = ['IRON', 'BRONZE', 'SILVER', 'GOLD', 'PLATINUM', 'EMERALD', 'DIAMOND', 'MASTER', 'GRANDMASTER', 'CHALLENGER'];
const DIVS = ['IV', 'III', 'II', 'I'];
const APEX_BASE = 7 * 400; // Master+ share one continuous LP ladder
const CREST = (tier) =>
  `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-static-assets/global/default/images/ranked-mini-crests/${tier.toLowerCase()}.svg`;

const ui = { queue: 'RANKED_SOLO_5x5', days: 7 };
let state = null;
let chart = null;
let ddragonVersion = null;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const color = (p) => css(`--s${p.color % 8}`);

// ---------- rank math ----------

function rankValue(s) {
  const t = TIERS.indexOf(s.tier);
  if (t >= 7) return APEX_BASE + s.lp;
  return t * 400 + DIVS.indexOf(s.rank) * 100 + s.lp;
}

const titleCase = (s) => s.charAt(0) + s.slice(1).toLowerCase();

function rankLabel(s) {
  const tier = titleCase(s.tier);
  return TIERS.indexOf(s.tier) >= 7 ? tier : `${tier} ${s.rank}`;
}

function valueLabel(v) {
  if (v >= APEX_BASE) return v === APEX_BASE ? 'Master' : `Master+ ${v - APEX_BASE}`;
  const t = Math.floor(v / 400);
  const d = Math.floor((v % 400) / 100);
  return `${titleCase(TIERS[t])} ${DIVS[d]}`;
}

const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

// ---------- time helpers ----------

function rangeStart() {
  return ui.days ? Date.now() - ui.days * 864e5 : 0;
}

function fmtTime(t, withDate = true) {
  const d = new Date(t);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return withDate ? `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}` : time;
}

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

// Last snapshot at or before t (or the first one after it, if none before).
function snapAt(hist, t) {
  let found = null;
  for (const s of hist) {
    if (s.t <= t) found = s;
    else break;
  }
  return found;
}

// ---------- data loading ----------

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

async function load() {
  state = await api('/api/state');
  render();
}

async function loadDdragon() {
  try {
    const versions = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
    ddragonVersion = versions[0];
  } catch {
    ddragonVersion = null;
  }
}

// ---------- rendering ----------

function render() {
  const { players, lastPoll, pollMinutes, apiKeySet } = state;
  $('status').textContent =
    `${players.length} player${players.length === 1 ? '' : 's'} · ` +
    (lastPoll ? `updated ${ago(lastPoll)}` : 'not polled yet') +
    ` · checks every ${pollMinutes} min`;

  const banner = $('banner');
  banner.hidden = apiKeySet;
  banner.textContent = 'No Riot API key configured. Copy .env.example to .env, paste your key from developer.riotgames.com, and restart the server.';

  const region = $('region');
  if (!region.options.length) {
    for (const r of state.regions) region.append(new Option(r.toUpperCase(), r, false, r === state.defaultRegion));
  }

  renderCards();
  renderChart();
  renderLog();
}

function renderCards() {
  const wrap = $('cards');
  wrap.replaceChildren();
  const start = rangeStart();

  for (const p of state.players) {
    const hist = p.history[ui.queue] || [];
    const cur = hist[hist.length - 1];
    const card = el('article', 'card');

    const rm = el('button', 'remove', '×');
    rm.title = `Stop tracking ${p.gameName}#${p.tagLine}`;
    rm.onclick = () => removePlayer(p);
    card.append(rm);

    const head = el('div', 'p-head');
    const icon = el('img', 'p-icon');
    icon.alt = '';
    if (ddragonVersion && p.profileIconId != null) {
      icon.src = `https://ddragon.leagueoflegends.com/cdn/${ddragonVersion}/img/profileicon/${p.profileIconId}.png`;
    }
    const who = el('div');
    who.style.minWidth = '0';
    const name = el('div', 'p-name', p.gameName);
    name.append(el('span', 'tag', ` #${p.tagLine}`));
    const sub = el('div', 'p-sub');
    const key = el('span', 'key');
    key.style.background = color(p);
    sub.append(key, document.createTextNode(`${p.region.toUpperCase()} · lvl ${p.summonerLevel ?? '?'}`));
    who.append(name, sub);
    head.append(icon, who);
    card.append(head);

    if (!cur) {
      card.append(el('div', 'rank-lp', 'Unranked in this queue'));
    } else {
      const rank = el('div', 'rank');
      const crest = el('img', 'crest');
      crest.alt = '';
      crest.src = CREST(cur.tier);
      crest.onerror = () => crest.remove();
      const txt = el('div');
      txt.append(el('div', 'rank-name', rankLabel(cur)), el('div', 'rank-lp', `${cur.lp} LP`));
      rank.append(crest, txt);
      card.append(rank);

      const games = cur.wins + cur.losses;
      const stats = el('div', 'stats');
      stats.append(el('span', null, `${cur.wins}W ${cur.losses}L · ${Math.round((cur.wins / games) * 100)}%`));

      const base = snapAt(hist, start) || hist.find((s) => s.t >= start);
      if (base && base !== cur) {
        const diff = rankValue(cur) - rankValue(base);
        const w = cur.wins - base.wins;
        const l = cur.losses - base.losses;
        const label = ui.days ? `${ui.days === 1 ? '24h' : `${ui.days}d`}` : 'all';
        const d = el('span', diff > 0 ? 'up' : diff < 0 ? 'down' : null, `${signed(diff)} LP ${label}`);
        d.title = `${w}W ${l}L in this range`;
        stats.append(d);
      }
      card.append(stats);
    }
    if (p.error) card.append(el('div', 'p-err', p.error));
    wrap.append(card);
  }
}

function buildDatasets() {
  const start = rangeStart();
  const now = Date.now();
  const sets = [];
  for (const p of state.players) {
    const hist = p.history[ui.queue] || [];
    if (!hist.length) continue;
    const pts = [];
    const before = snapAt(hist, start);
    // Carry the rank held at the start of the range in from the left edge.
    if (ui.days && before) pts.push({ x: start, y: rankValue(before), snap: before, synthetic: true });
    for (const s of hist) if (s.t >= start) pts.push({ x: s.t, y: rankValue(s), snap: s });
    if (!pts.length) continue;
    const last = pts[pts.length - 1];
    const end = Math.min(now, Math.max(p.lastChecked || 0, last.x));
    if (end > last.x) pts.push({ x: end, y: last.y, snap: last.snap, synthetic: true });
    sets.push({ player: p, pts });
  }
  return sets;
}

// End-of-line name labels when there's room; the legend above always carries identity too.
const directLabels = (c) => c.$sets?.length > 0 && c.$sets.length <= 4 && c.width >= 560;

// Crosshair, all-series readout and end-of-line labels.
const overlay = {
  id: 'overlay',
  afterDraw(c) {
    const { ctx, chartArea: a } = c;
    const sets = c.$sets || [];
    if (directLabels(c)) {
      const labels = c.data.datasets.map((ds, i) => {
        const meta = c.getDatasetMeta(i);
        const pt = meta.data[meta.data.length - 1];
        return { y: pt.y, text: ds.label, color: ds.borderColor };
      });
      labels.sort((x, y) => x.y - y.y);
      for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 14);
      ctx.save();
      ctx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      for (const l of labels) {
        ctx.fillStyle = l.color;
        ctx.fillRect(a.right + 6, l.y - 1, 8, 2);
        ctx.fillStyle = css('--text-2');
        ctx.fillText(l.text.length > 12 ? l.text.slice(0, 11) + '…' : l.text, a.right + 18, l.y);
      }
      ctx.restore();
    }
    if (c.$hoverX != null) {
      ctx.save();
      ctx.strokeStyle = css('--grid-strong');
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(c.$hoverX, a.top);
      ctx.lineTo(c.$hoverX, a.bottom);
      ctx.stroke();
      // Hover dots where the crosshair meets each line, ringed in the surface color.
      for (const r of c.$hoverRows || []) {
        ctx.beginPath();
        ctx.arc(c.$hoverX, c.scales.y.getPixelForValue(r.y), 4, 0, Math.PI * 2);
        ctx.fillStyle = color(r.player);
        ctx.strokeStyle = css('--surface');
        ctx.lineWidth = 2;
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }
  },
  afterEvent(c, { event }) {
    const a = c.chartArea;
    const tip = $('tip');
    const inside = event.x >= a.left && event.x <= a.right && event.y >= a.top && event.y <= a.bottom;
    if (event.type === 'mouseout' || !inside) {
      if (c.$hoverX != null) {
        c.$hoverX = null;
        tip.hidden = true;
        c.draw();
      }
      return;
    }
    const t = c.scales.x.getValueForPixel(event.x);
    const rows = [];
    for (const { player, pts } of c.$sets) {
      let hit = null;
      for (const pt of pts) {
        if (pt.x <= t) hit = pt;
        else break;
      }
      if (hit) rows.push({ player, snap: hit.snap, y: hit.y });
    }
    c.$hoverX = event.x;
    c.$hoverRows = rows;
    c.draw();
    if (!rows.length) {
      tip.hidden = true;
      return;
    }
    rows.sort((x, y) => y.y - x.y);
    tip.replaceChildren(el('div', 'when', fmtTime(t)));
    for (const r of rows) {
      const row = el('div', 'row');
      const key = el('span', 'key');
      key.style.background = color(r.player);
      row.append(key, el('strong', null, `${rankLabel(r.snap)} · ${r.snap.lp} LP`), el('span', 'who', r.player.gameName));
      tip.append(row);
    }
    tip.hidden = false;
    const box = tip.parentElement.getBoundingClientRect();
    const left = event.x + 14 + tip.offsetWidth > box.width ? event.x - 14 - tip.offsetWidth : event.x + 14;
    tip.style.left = `${Math.max(0, left)}px`;
    tip.style.top = `${a.top}px`;
  },
};

function renderChart() {
  const sets = buildDatasets();
  $('empty').hidden = sets.length > 0;
  $('tip').hidden = true;

  const legend = $('legend');
  legend.replaceChildren();
  if (sets.length >= 2) {
    for (const { player } of sets) {
      const item = el('span');
      const key = el('span', 'key');
      key.style.background = color(player);
      item.append(key, document.createTextNode(player.gameName));
      legend.append(item);
    }
  }

  const datasets = sets.map(({ player, pts }) => ({
    label: player.gameName,
    data: pts,
    borderColor: color(player),
    backgroundColor: color(player),
    borderWidth: 2,
    stepped: true,
    pointRadius: 0,
    pointHoverRadius: 0,
  }));

  const ys = sets.flatMap((s) => s.pts.map((p) => p.y));
  const xs = sets.flatMap((s) => s.pts.map((p) => p.x));
  const yMin = ys.length ? Math.max(0, Math.floor((Math.min(...ys) - 30) / 100) * 100) : 0;
  const yMax = ys.length ? Math.ceil((Math.max(...ys) + 30) / 100) * 100 : 400;
  const xMin = ui.days ? rangeStart() : xs.length ? Math.min(...xs) : Date.now() - 864e5;
  const xMax = Date.now();
  const short = xMax - xMin <= 864e5 * 1.5;
  const step = yMax - yMin > 1600 ? 400 : 100;

  const grid = css('--grid');
  const gridStrong = css('--grid-strong');
  const muted = css('--muted');
  const font = { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 11 };

  if (chart) chart.destroy();
  chart = new Chart($('chart'), {
    type: 'line',
    data: { datasets },
    plugins: [overlay],
    options: {
      animation: false,
      maintainAspectRatio: false,
      parsing: false,
      normalized: true,
      events: ['mousemove', 'mouseout', 'touchstart', 'touchmove'],
      layout: { padding: { right: sets.length && sets.length <= 4 && $('chart').parentElement.clientWidth >= 560 ? 96 : 8, top: 4 } },
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: {
          type: 'linear',
          min: xMin,
          max: xMax,
          grid: { display: false },
          border: { color: gridStrong },
          ticks: {
            color: muted,
            font,
            maxTicksLimit: 7,
            callback: (v) =>
              short ? fmtTime(v, false) : new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric' }),
          },
        },
        y: {
          min: yMin,
          max: yMax,
          border: { display: false },
          grid: {
            color: (ctx) => (ctx.tick.value % 400 === 0 && ctx.tick.value <= APEX_BASE ? gridStrong : grid),
          },
          ticks: { color: muted, font, stepSize: step, autoSkip: false, callback: (v) => valueLabel(v) },
        },
      },
    },
  });
  chart.$sets = sets;
}

function renderLog() {
  const body = $('log');
  body.replaceChildren();
  const start = rangeStart();
  const rows = [];
  for (const p of state.players) {
    const hist = p.history[ui.queue] || [];
    hist.forEach((s, i) => {
      if (s.t < start) return;
      rows.push({ p, s, prev: hist[i - 1] });
    });
  }
  rows.sort((a, b) => b.s.t - a.s.t);

  if (!rows.length) {
    const tr = el('tr');
    const td = el('td', null, 'No changes recorded in this range.');
    td.colSpan = 5;
    td.style.color = 'var(--muted)';
    tr.append(td);
    body.append(tr);
    return;
  }

  for (const { p, s, prev } of rows.slice(0, 200)) {
    const tr = el('tr');
    const who = el('td');
    const key = el('span', 'key');
    key.style.background = color(p);
    key.style.marginRight = '6px';
    who.append(key, document.createTextNode(p.gameName));

    let lpCell;
    if (prev) {
      const diff = rankValue(s) - rankValue(prev);
      lpCell = el('td', `num ${diff > 0 ? 'up' : diff < 0 ? 'down' : ''}`, `${signed(diff)} (${s.lp})`);
    } else {
      lpCell = el('td', 'num', `${s.lp} · first seen`);
    }
    tr.append(el('td', null, fmtTime(s.t)), who, el('td', null, rankLabel(s)), lpCell, el('td', 'num', `${s.wins} / ${s.losses}`));
    body.append(tr);
  }
}

// ---------- actions ----------

async function removePlayer(p) {
  if (!confirm(`Stop tracking ${p.gameName}#${p.tagLine}? Their LP history will be deleted.`)) return;
  try {
    await api(`/api/players/${encodeURIComponent(p.puuid)}`, { method: 'DELETE' });
    await load();
  } catch (err) {
    alert(err.message);
  }
}

$('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('addMsg');
  const btn = e.submitter;
  msg.className = 'add-msg';
  msg.textContent = 'Looking up…';
  btn.disabled = true;
  try {
    const p = await api('/api/players', {
      method: 'POST',
      body: JSON.stringify({ riotId: $('riotId').value, region: $('region').value }),
    });
    msg.textContent = `Added ${p.gameName}#${p.tagLine}.`;
    $('riotId').value = '';
    await load();
  } catch (err) {
    msg.className = 'add-msg err';
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

$('refresh').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  try {
    await api('/api/refresh', { method: 'POST' });
    await load();
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Refresh now';
  }
});

function wireSeg(id, onPick) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of $(id).children) x.classList.toggle('on', x === b);
    onPick(b.dataset.v);
    if (state) render();
  });
}
wireSeg('queueSeg', (v) => (ui.queue = v));
wireSeg('rangeSeg', (v) => (ui.days = Number(v)));

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => state && render());

(async () => {
  await load().catch((err) => ($('status').textContent = err.message));
  await loadDdragon();
  if (state) renderCards();
  setInterval(() => load().catch(() => {}), 60000);
})();
