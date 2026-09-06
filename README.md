# Battle Arena

A fast-paced top-down multiplayer arena battle game. Move, aim, shoot, collect
power-ups, and rack up the highest score before the round timer runs out.
Built with vanilla HTML5/CSS3/JavaScript on the client (Canvas 2D rendering,
no frameworks) and Node.js + Express + Socket.IO on the server, which is
authoritative for all gameplay-affecting state.

## Project structure

```
battle-arena/
├── package.json
├── server.js               # Authoritative game server (Express + Socket.IO)
├── README.md
└── public/
    ├── index.html           # All screens: menu, lobby, HUD, end screen, modals
    ├── style.css            # Neon arcade styling, fully responsive
    ├── network.js            # Socket.IO client wrapper
    ├── audio.js               # Web Audio API synthesized sound effects
    ├── game.js                # Rendering, input, effects, UI wiring
    └── shared/
        └── constants.js       # Tuning constants shared by client & server
```

## 1. Install Node.js dependencies

Requires [Node.js](https://nodejs.org/) 16 or later.

```bash
cd battle-arena
npm install
```

This installs `express` and `socket.io` (see `package.json`).

## 2. Start the server

```bash
npm start
```

You should see:

```
Battle Arena server running on http://localhost:3000
```

## 3. Open the game

Open a browser and go to:

```
http://localhost:3000
```

Enter a callsign, pick a color, and click **Quick Play** to jump straight
into a public match, or **Multiplayer** to create a private room / join one
by 4-letter code.

## 4. Connecting multiple players

- **Same machine (quick local test):** open several browser tabs/windows to
  `http://localhost:3000` — each tab is treated as its own player/socket.
- **Other devices on your network:** find your machine's LAN IP
  (e.g. `192.168.1.42`, via `ipconfig` on Windows or `ifconfig`/`ip a` on
  macOS/Linux), then on other devices browse to `http://<your-LAN-IP>:3000`.
  Make sure your firewall allows inbound connections on port 3000.
- To play together in the same match: one player clicks **Multiplayer →
  Create Room**, shares the 4-letter room code shown in the lobby, and the
  others click **Multiplayer → Join Room** and enter that code. Alternatively
  everyone can just click **Quick Play** to be matched into the same public
  room automatically.

## 5. Testing multiplayer locally

1. Start the server (`npm start`).
2. Open two or more browser tabs to `http://localhost:3000`.
3. In tab 1: **Multiplayer → Create Room**, note the room code, click
   **Ready Up**.
4. In tab 2+: **Multiplayer → Join Room**, enter the code, click **Ready Up**.
5. In tab 1 (the host), click **Start Game**. A 3‑second countdown plays,
   then the round begins — move with WASD/arrows, aim with the mouse, and
   left-click to attack.
6. Watch the health bars, kill feed, leaderboard, and round timer update in
   real time across every tab, confirming server-authoritative sync.
7. When the round timer hits zero, the end screen shows final rankings; the
   host can click **Play Again** (same room, new round) or **Return to
   Lobby**.

To simulate mobile controls, open Chrome/Firefox DevTools, toggle device
emulation (touch mode), and reload — the virtual joystick, touch-aim zone,
and attack button appear automatically below ~820px width or on any
touch-capable device.

## 6. Deploying to a production server

The app is a single Node process serving both the static client and the
Socket.IO websocket endpoint, so most Node hosts work out of the box.

**Generic VPS (Ubuntu/Debian, etc.):**

```bash
git clone <your-repo-url> battle-arena
cd battle-arena
npm install --production
PORT=3000 npm start
```

Run it under a process manager so it survives reboots/crashes, e.g. with
[pm2](https://pm2.keymetrics.io/):

```bash
npm install -g pm2
pm2 start server.js --name battle-arena
pm2 save
pm2 startup
```

Put a reverse proxy (nginx, Caddy) in front for TLS and to expose port 443:

```nginx
server {
    listen 443 ssl;
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

The `Upgrade`/`Connection` headers above are required for Socket.IO's
WebSocket transport to work behind the proxy.

**Platform-as-a-service (Render, Railway, Fly.io, Heroku-style hosts):**

- Set the start command to `npm start`.
- The server reads `process.env.PORT`, so no code changes are needed — the
  platform's assigned port is picked up automatically.
- No database or external services are required; all game state lives in
  server memory per room.

**Deploying to Render specifically:**

This repo includes a `render.yaml` Blueprint, so Render can configure the
service automatically:

1. Push this repo to GitHub (or GitLab).
2. In the Render dashboard: **New +** → **Blueprint**, then select the repo.
   Render reads `render.yaml` and creates a Node web service with the build
   command (`npm install`), start command (`npm start`), and health check
   already set.
3. Alternatively, without the Blueprint: **New +** → **Web Service** → select
   the repo → Environment: `Node` → Build Command: `npm install` → Start
   Command: `npm start`.
4. No environment variables are required — Render sets `PORT` automatically
   and the server already reads it.
5. Once deployed, Render gives you a public `https://<service-name>.onrender.com`
   URL. Socket.IO's WebSocket transport works out of the box on Render's web
   services, so no extra proxy configuration is needed.
6. Free-tier Render services spin down after inactivity and take a few
   seconds to wake on the next request — the first player to open the link
   after a quiet period will see a brief load delay before the page appears.

## How the game works

- **Rooms:** every match happens inside a room (public quick-play room or a
  private room with a 4-letter code). Each room runs its own independent
  30-times-per-second simulation loop.
- **Authoritative server:** clients only ever send *input* (movement vector,
  aim angle, attack held). The server owns positions, health, cooldowns,
  damage, power-up pickups, scoring, and round timing, and validates/clamps
  everything server-side — a modified client cannot move faster, attack
  faster, or claim damage/pickups it didn't actually get.
- **Rounds:** Free-For-All. Every player fights everyone else for 3 minutes;
  kills add to your score. Dying drops you for 3 seconds, then you respawn
  with brief invulnerability. Highest score when the timer ends wins the
  round. The host can start another round or return everyone to the lobby
  without restarting the server.
- **Power-ups:** Speed Boost, Health Restore, Shield, Rapid Attack, and
  Damage Boost spawn periodically around the arena and are picked up by
  server-side proximity checks (not client claims).
- **Combat:** a ranged poke (left click / ⚔) plus a harder-hitting, short-range
  melee counter (right click, Space, or 👊) with its own server-enforced
  cooldown, range and aim cone.
- **AI bots:** from the lobby, the host can click **+ Bot** to fill empty
  slots with AI opponents (chase/kite/retreat logic, wander when no target is
  near) — great for solo practice or padding out a small group. They run
  through the exact same server-side movement/attack code path as a human
  input, so they can't do anything a player couldn't.
- **Kill streaks:** consecutive kills without dying award escalating bonus
  points and trigger an on-screen callout (Double Kill → Godlike).
- **Minimap, kill-cam juice, and ambient music:** a corner minimap tracks
  players and power-ups; landing a kill gets a brief freeze-frame + gold
  flash; a sparse generative ambient pad (Web Audio, toggleable) plays during
  rounds.
- **Local stats:** games played, wins, total kills and best score persist in
  your browser (`localStorage`) and show on the main menu — no account needed.
- **Armory (character progression):** winning a round earns Credits. Open
  **🛒 Armory** from the main menu to spend them on:
  - **Weapons** — Blaster (default), Rapid Fire, Shotgun (4-pellet spread),
    Railgun (slow, huge single-hit damage). Each has real, distinct stats.
  - **Upgrades** — Vitality (+Max HP), Agility (+Move Speed), Reflexes
    (-Attack Cooldown), Brawler (+Melee Damage); 3 levels each, rising cost.

  Progression lives in `localStorage` alongside your stats. Your equipped
  weapon and upgrade levels are sent as an *id/level* when you join a match —
  the server independently looks up the real numbers from its own copy of
  the same catalog (`public/shared/constants.js`) and clamps everything to
  known bounds, so this system can't be used to smuggle arbitrary stats onto
  a player; a modified client can at most equip something it hasn't paid for.

Enjoy the arena!
