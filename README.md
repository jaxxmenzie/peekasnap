# PeekaSnap 👀 — snap your friends, then hunt them down

A Snapchat-style social app in **black & red**, with two location games built in: **Hide & Seek** and **Manhunt**.
Installable to your Home Screen with push alerts.

## Run it

```bash
npm install
npm start            # http://localhost:3000   (PORT=xxxx to change)
npm test             # smoke (hide & seek) + social + manhunt end-to-end tests
node test/pwa-check.js     # installable-app checks (Chrome)
node test/screenshots.js   # regenerate screenshots (needs Chrome at /usr/bin/google-chrome or CHROME=...)
```

Needs Node 18+. Optional env vars: `PORT`, `DATA_DIR`, `UPLOAD_DIR`, `FIND_RADIUS_M` (default 25), `MIN_PING_DELAY_MS` (default 300000 = 5 min), `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` (push), `ALLOW_TEST_CLOCK=1` (tests only). No database to install: data lives in `data/db.json`, photos in `uploads/` (snaps in a private `data/snaps/`).

## The app

Bottom nav: **Map · Chat · Camera (home) · Stories · Play**.

- **Sign up** with a display name and a unique `@username` (no password; remembered on the device).
- **Friends**: search by username, send/accept requests (👤 top right), share an add-me link (`/?add=username`). 🔥 streaks count days you both snapped each other.
- **Snaps**: the camera opens first. Snap, then add a caption, draw (colors + undo), drop emoji stickers, and set a timer (1–10 s or ∞). Send to friends, groups, and/or **My Story**. Snaps open once with a countdown ring, can be replayed once (within 10 min), then are deleted from the server. Unopened snaps expire after 30 days (group snaps after 24 h). Screenshot blocking isn't possible on the web.
- **Chat**: 1:1 (friends only) and group chats with text and photos, typing indicator, Snapchat-style statuses (New Snap / New Chat / Delivered / Opened) and read receipts.
- **Deleting**: swipe a chat left or long-press it to **delete the conversation for you** (the other person keeps theirs; it comes back only if someone sends something new). Long-press a message: if you sent it, **unsend it for everyone** (unsending an unopened snap pulls it from their inbox); otherwise delete it just for you. Group chats can also be deleted from your list, and **Leave group** (⋯ in the chat) removes it for good. Every delete asks for confirmation first.
- **Stories**: My Story (24 h, see who viewed, delete), friends' stories bar with tap-through viewer.
- **Snap Map**: friends who share their location. **Ghost Mode is on by default**; you choose to share. During an active Manhunt your location is shared with that game only.
- **Groups**: create or join with a 6-letter code / invite link (`/?join=CODE`). Groups have their own chat and play both games.

## Play tab

### Game mode 1: Hide & Seek

1. **Groups** (the group pill on the Play tab): create a group and share its 6-letter code or invite link (`/?join=CODE`), or join one. Switch groups any time; every group has its own hides, chat, and leaderboard.
2. **Hide**: Play → *Hide something* (or snap anything and tap 🫣 *Hide* in the editor) → name it, set the play area (🎯 center + radius slider), mark the hiding spot (🫣: tap *I'm at the hiding spot*, drag it, or tap the map), and pick the ping schedule (first ping in X min or at a set time, then every N min, for N pings). **The first ping is always at least 5 minutes after you mark the spot**, so you have time to get away. Anyone in the group can be the hider.
4. **Seek**: open the hide from the story bubbles. You see the photo and the play area, never the exact spot.
5. **Pings**: at each scheduled time everyone in the group gets a red banner, a sonar sound, a vibration, and a system notification (if alerts are on). Each ping draws a smaller red hint circle that always contains the spot (radius × 0.6 per ping, min 30 m, centered a random offset from the spot) and unlocks **one hot/cold check** (🔥 ≤25 m, hot ≤75 m, warm ≤200 m, cool ≤500 m, cold).
6. **Found it**: tap *I found it!* and snap a proof photo. The server compares your GPS with the hidden spot. Within **25 m** the find is accepted automatically. Otherwise it goes to the hider, who sees the photo and distance and can confirm ✓ or reject ✕.
7. **Move / rename on ping (hider only):** each time a ping fires, the hider gets a "🔀 Move it" button in the ping alert, and in the hide's story view. Until the next ping they get **one** change: drag 🫣 or tap *I'm at the new spot* to move it (it has to stay inside the play area), rename the object, and/or snap a new photo. Seekers get a "moved/renamed" alert with no location. The old hint circle turns grey and dashed ("out of date"), and each seeker gets a fresh hot/cold check that measures distance to the new spot. If the spot moved, **the next ping waits at least 5 minutes after the new spot is marked**, and its hint circle starts shrinking again around the new spot. If the move happens after the last ping, the end of the hunt is pushed back by 5 minutes instead. A rename-only change doesn't delay anything.
8. If nobody finds it within one interval after the last ping, the hider "escapes". The spot is revealed on the map once a round ends.

**Points:** a find = 10 + 5 per unused ping · the hider gets 3 per ping survived · an escape = +10.

### Game mode 2: Manhunt

1. Play → **Manhunt** opens a lobby for the current group. Others tap *Join*.
2. The host sets the play-area circle (center on me, or tap the map; radius), game length, ping interval (default 5 min; first ping 5 min after start), runner head start (default 2 min), number of hunters, whether hunters are shown to runners at pings, and whether tagged runners become hunters or spectators. Teams are random or picked by the host.
3. **Start**: runners get the head start (hunters see a locked TAG countdown). Location is sent only while the game is running.
4. **Pings**: every interval, hunters get all runners' current locations as markers that fade over time (and runners see hunters if that option is on). Everyone gets an alert. Teammates see each other live.
5. **Out of bounds**: a runner who leaves the circle is warned and instantly revealed to hunters.
6. **Tag**: a hunter taps 🎯 TAG within **15 m** of a runner (by GPS) and it counts. If GPS can't confirm, the hunter picks the runner and that runner confirms or denies.
7. Hunters win when every runner is caught; runners win if anyone survives the timer. Live scoreboard (tag = 10, 3 per ping survived, +20 for surviving), game chat, and push + in-app alerts for start, release, pings, tags, and the end.

## Put it on your Home Screen (installable app)

PeekaSnap is an installable PWA. It opens full-screen in portrait with a black status bar and has its own icon and splash screen.

- **Android (Chrome)**: an in-app **Install** card appears (or use *Groups → 📲 Add to Home Screen*, or Chrome menu → *Install app*).
- **iPhone (Safari)**: the in-app card walks you through **Share → Add to Home Screen → Add**. Open PeekaSnap from the Home Screen icon.
- The card hides itself when PeekaSnap is already running from the Home Screen. "Not now" snoozes it for 3 days.
- **Ping alerts**: tap *Turn on ping alerts* (inside the installed app on iPhone, which needs iOS 16.4 or later). Alerts for pings, moves, finds and find claims arrive as system notifications through **Web Push**, even when the app is closed. Keys are generated automatically in `DATA_DIR/vapid.json`, or set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT`.
- **Offline**: a service worker caches the app shell and photos. With no connection the app still opens, or shows an offline page and reconnects automatically.
- Icons and splash screens are generated by `node scripts/make-assets.js`. `node test/pwa-check.js` checks installability in Chrome and retakes the install-prompt screenshots.
- Installing, the service worker and push all require **HTTPS**, so use one of the hosts below.

## Deploy for free so friends can play

**Camera and GPS only work over HTTPS** (or on `localhost`). All of the hosts below give you HTTPS automatically.

- **Render** (easiest): push this folder to GitHub → render.com → New → Web Service → pick the repo. Build `npm install`, start `npm start`. The free tier sleeps when idle (about 30 s to wake up) and **wipes the disk on each restart/deploy**. For persistent data, add a Render Disk (paid) and set `DATA_DIR` and `UPLOAD_DIR` to a folder on it.
- **Railway**: New Project → Deploy from GitHub repo. It detects Node and runs `npm start`. Add a Volume mounted at `/data` and set `DATA_DIR=/data/db` and `UPLOAD_DIR=/data/uploads` so games survive redeploys. Uses trial or free monthly credits.
- **Fly.io**: `fly launch` (uses the included `Dockerfile`), then `fly volumes create data --size 1`, and add `[mounts] source="data" destination="/data"` to `fly.toml`. Then `fly deploy`.
- **Quick test from your own computer**: `npm start`, then `npx localtunnel --port 3000` or `cloudflared tunnel --url http://localhost:3000` gives you a temporary HTTPS link to share.

Run a single instance. Ping timers and the JSON store live in one process.

## Tech

- `server.js`: Express REST API, Socket.IO realtime (per-user and per-group rooms), multer uploads, JSON-file persistence, Web Push (VAPID), and the Hide & Seek scheduler. `lib/social.js`: friends, snaps, chats, deleting, stories, Snap Map. `lib/manhunt.js`: Manhunt lobby, timers, pings, tags, scoring.
- `public/`: vanilla JS single-page app (no build step): `app.js` (social core), `game.js` (Hide & Seek), `hunt.js` (Manhunt). Leaflet + OpenStreetMap, `getUserMedia` camera with a file-input fallback, service worker (offline shell + push), PWA manifest.
- Hidden spots are never sent to seekers while a round is active, and runners' positions only go to hunters at pings or when out of bounds. Distance checks happen on the server.

## Limitations

- Sign-in is username-only; whoever has the device token is that user. Story and chat photo URLs are unguessable but not access-controlled (snap photos are private and served once).
- No screenshot detection or blocking (browsers don't allow it).
- GPS can be off by 5–30 m, which is why tags and finds have a confirm fallback. Background location doesn't run on iOS/Android web when the app is closed, so keep the app open during a Manhunt.
- On Render's free plan the data file is wiped on every deploy/restart, and the service sleeps when idle (first load can take ~1 min).
- Uses the public OpenStreetMap tile server: fine for a small group, not heavy traffic.
