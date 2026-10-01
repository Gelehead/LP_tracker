# LoL Rank Tracker

Tracks the ranked progress of a group of players and graphs their LP over time.

RAHHH WE CLIMBING

## Setup

1. Get an API key at https://developer.riotgames.com (log in with your Riot account).
2. Create a .env, follow model `.env.example`
3. Start it:
   ```
   npm start
   ```
4. Open http://localhost:3000 and add players by Riot ID (`Name#TAG`) and server.
5. If you want to publish, use cloudflare

Requires Node 22.9+. There are no npm dependencies.

## How it works

- The Riot API only gives a player's *current* rank, so the server checks everyone every
  `POLL_MINUTES` (default 5) and saves a snapshot whenever LP, rank or W/L changes.
  **The graph only covers the time the server has been running**, so leave it running
  (or host it somewhere always-on).
- Data is stored in `data/db.json`.
- Solo/Duo and Flex are tracked separately; switch with the toggle above the cards.
- On the graph, Master, Grandmaster and Challenger share one LP scale above Diamond I.
