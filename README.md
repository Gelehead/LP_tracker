# LoL Rank Tracker

Tracks the ranked progress of a group of players and graphs their LP over time.

## Setup

1. Get an API key at https://developer.riotgames.com (log in with your Riot account).
2. Copy `.env.example` to `.env` and paste the key into `RIOT_API_KEY`.
3. Start it:
   ```
   npm start
   ```
4. Open http://localhost:3000 and add players by Riot ID (`Name#TAG`) and server.

Requires Node 22.9+. There are no npm dependencies.

## How it works

- The Riot API only gives a player's *current* rank, so the server checks everyone every
  `POLL_MINUTES` (default 5) and saves a snapshot whenever LP, rank or W/L changes.
  **The graph only covers the time the server has been running**, so leave it running
  (or host it somewhere always-on).
- Data is stored in `data/db.json`.
- Solo/Duo and Flex are tracked separately; switch with the toggle above the cards.
- On the graph, Master, Grandmaster and Challenger share one LP scale above Diamond I.

## About the API key

Development keys **expire every 24 hours**. When that happens the cards show a
"key rejected" error: regenerate the key, update `.env`, and restart. For a key that
doesn't expire, register a **Personal API Key** product on the developer portal (free,
approval takes a few days).
