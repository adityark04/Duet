# Duet: online karaoke

Sing karaoke with friends who can't be in the same place.

**Use it:** https://adityark04.github.io/Duet/ (front end on GitHub Pages; the server runs on Render, see *Put it online for free*).

## Run it

```
npm install
npm start
```

Open http://localhost:3000. Data (accounts, signing key) is stored in `data/`.

## What it does

- **Accounts.** Sign up with a name and password. Each account gets a unique ID like `KR-9WP9R8` (shown after sign-up and in the top bar).
- **Solo.** Just you, a YouTube lyrics video and your mic. Record and download.
- **Public rooms.** Listed for everyone signed in. Up to 10 people each.
- **Private rooms.** The creator picks the size, 5 to 10 people. Each room gets a 5-character code (A–Z, 0–9), for example `BLYF4`. Only people with the code (or the invite link) can join.
- **Singing together.** Anyone pastes a YouTube link. The video plays in sync for everyone. Voices travel peer-to-peer over WebRTC so everyone hears each other live over the music. Anyone can play, pause, seek or restart.
- **Party roles.** Whoever creates a room is its Leader (an admin). Admins can make others admin, mute someone in chat, delete messages, clear the chat, remove people (they can't rejoin), and choose in **Room settings** who can add songs, who controls the music and who can chat (everyone or admins only). The server enforces all of it. If every admin leaves, the longest-present member becomes one.
- **Hands-free sync.** One person plays, pauses, skips, seeks or changes the speed, and it happens for everyone; new songs start for everybody on a shared 1.5 s count-in. If a browser won't allow sound yet (someone opened an invite link and hasn't tapped the page), the song plays muted but in sync until they tap once.
- **FAQ.** All "how it works" help lives on the FAQ page (`#/faq`), readable without signing in.
- **Up next.** Paste YouTube links to line songs up (thumbnails and titles shown). When a song ends the next one starts for everyone; anyone can skip or remove songs. Videos whose uploader blocks embedding are caught before they're added.
- **Voice, video and chat.** Everyone in a room hears each other live. Turn on your camera to appear in the *Voice & video* tiles; a ring glows around whoever is singing. A live text chat sits beside the stage, with the last 50 messages shown to people who join late.
- **Recording.** Anyone in the room (or solo) presses **Record song**. The video is the *Voice & video* panel (everyone's cameras, or initials when a camera is off, with a ring on whoever is singing), not the YouTube video. The sound is everyone's voices, with your own mic taken from a clean, unprocessed feed. **Include the backing music** (on by default) adds the song: the browser asks to share **this tab** with **Also share tab audio** on. Untick it for voices only, with no share prompt. When the song ends the song pauses and a dialog appears; the server converts the take to a normal, seekable **MP4** (ffmpeg; Chrome records H.264/AAC, so this is just a fast repackage) and you download it. The original file is offered as a backup.

## Good to know

- **Use headphones.** Otherwise the music from your speakers gets into your mic and echoes to everyone.
- **Best in Chrome or Edge on a computer.** Tab-audio capture is a Chromium feature. Other browsers fall back to recording voices only (no music).
- **Some videos won't embed.** If the uploader blocks embedding, YouTube shows an error. Try a different lyrics or karaoke upload.
- **Latency.** Each person hears their own copy of the track plus the others' voices with a small network delay (typically 100–300 ms). Recordings line up your own voice with the music exactly; friends' voices carry that small delay.
- **Going online.** Friends on other networks need the app hosted with HTTPS (browsers only allow the microphone on `https://` or `localhost`). See *Put it online for free* below.

## Put it online for free (GitHub Pages + Render + Upstash)

GitHub Pages only serves static files, so Duet runs in two halves:

| Part | Where | What it is |
| --- | --- | --- |
| Front end | **GitHub Pages**: `https://<you>.github.io/<repo>/` | The `public/` folder. This is the link you share. |
| Server | **Render** free web service | `server.js`: sign-in, rooms, chat, voice connections, MP4 conversion. |
| Accounts | **Upstash** free Redis | Render's free plan wipes its disk, so accounts live here. |

1. **Upstash** (accounts). Sign up at [upstash.com](https://upstash.com), create a Redis database (free plan, region **Singapore / ap-southeast-1** to sit next to the Render server in `render.yaml`), open its **REST API** section and copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
2. **Render** (server). Sign up at [render.com](https://render.com) with GitHub, then **New > Blueprint**, pick this repo. When asked, fill in:
   - `CORS_ORIGINS` = `https://<you>.github.io` (no repo path, no trailing slash)
   - `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` from step 1

   When it's live, open `https://<service>.onrender.com/healthz`. It should show `"store":"redis"` and your Pages address under `cors`.
3. **GitHub Pages** (front end). In the repo on github.com:
   - **Settings > Pages > Source: GitHub Actions**
   - **Settings > Secrets and variables > Actions > Variables > New repository variable**: `DUET_API_URL` = `https://<service>.onrender.com`
   - **Actions > Deploy front end to GitHub Pages > Run workflow** (it also runs on every push that changes `public/`).
4. Open `https://<you>.github.io/<repo>/`, sign up, and share room codes or invite links.

Free-plan notes: the server sleeps after about 15 minutes with nobody on it; the first visit afterwards takes up to a minute while it wakes (the app says so). For friends on strict networks (mobile data, offices) add a hosted TURN relay (`TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` in Render).

## Hosting (all settings)

Settings come from environment variables; see [.env.example](.env.example). `npm start` reads a `.env` file if there is one.

| Variable | What it does |
| --- | --- |
| `SESSION_SECRET` | Signs login tokens. Set it, or everyone is signed out when the server moves. |
| `DATA_DIR` | Where accounts are stored (when not using Redis). Put it on a persistent disk. |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | Store accounts in Upstash Redis instead of a file. |
| `CORS_ORIGINS` | Other sites allowed to use this server, e.g. `https://you.github.io`. |
| `TURN_URLS` + `TURN_SECRET` | Your own coturn. The server mints short-lived TURN logins per user. |
| `TURN_URLS` + `TURN_USERNAME` + `TURN_CREDENTIAL` | A hosted TURN provider with fixed credentials. |
| `FORCE_HTTPS`, `TRUST_PROXY` | HTTPS redirect, and how many proxies sit in front of the app. |
| `FFMPEG_PATH`, `EXPORT_MAX_MB`, `EXPORT_MAX_JOBS` | MP4 converter: binary (defaults to the bundled `ffmpeg-static`), upload size limit (600 MB), conversions at once (2). |

### Abuse protection

Built-in limits keep one person (or a script) from guessing passwords or private room codes, or from overloading the server. Defaults suit a small free server; change them with environment variables.

| Variable | Default | Limits |
| --- | --- | --- |
| `RATE_API_PER_MIN` | 300 | API calls per minute, per IP |
| `RATE_SIGNUP_PER_HOUR` | 5 | New accounts per hour, per IP |
| `RATE_LOGIN_PER_15MIN` | 20 | Sign-in attempts per 15 min, per IP (and 10 per username) |
| `RATE_ROOMS_PER_HOUR` | 10 | Rooms created per hour, per person |
| `RATE_CODE_LOOKUPS_PER_10MIN` | 30 | Room-code lookups and joins per 10 min, per person |
| `RATE_EXPORTS_PER_HOUR` | 10 | Recording conversions per hour, per person (one at a time) |
| `RATE_CONNECTS_PER_MIN` | 30 | Live connections opened per minute, per IP |
| `MAX_CONNECTIONS_PER_IP` | 20 | Live connections open at once, per IP |
| `MAX_ACCOUNTS` / `MAX_ROOMS` / `MAX_ROOMS_PER_USER` | 10000 / 300 / 3 | Totals |
| `MAX_PASSWORD_CHECKS` / `MAX_PASSWORD_QUEUE` | 2 / 30 | Password checks at once / waiting (then "busy") |
| `EXPORT_MAX_MB` | 250 | Largest recording upload |

### Room cleanup

Rooms live in the server's memory. A sweep every `ROOM_SWEEP_MS` (10 s) removes people whose connection has gone and deletes rooms that have been empty long enough:

| Variable | Default | Room deleted after being empty for |
| --- | --- | --- |
| `ROOM_UNUSED_MS` | 90 s | a room nobody ever joined (time to share the code) |
| `ROOM_IDLE_PUBLIC_MS` | 30 s | a public room |
| `ROOM_IDLE_PRIVATE_MS` | 10 min | a private room (friends can drop out and rejoin) |
| `PING_INTERVAL_MS` / `PING_TIMEOUT_MS` | 10 s / 10 s | a vanished connection is noticed within about 20 s |

When the last person leaves mid-song, the song is paused at the point it had reached. Empty rooms stop counting towards `MAX_ROOMS_PER_USER` after `ROOM_UNUSED_MS`. Leftover temp files from an interrupted recording conversion are removed after an hour.

Live events (chat, reactions, playback controls, call set-up) each have a per-person budget; floods are dropped and a connection that keeps flooding is closed.

Rate limits are per IP, so the server must see each visitor's real address. Open `/api/whoami` on your server: `ip` should be your own public IP. If it shows a proxy's address instead, set `CLIENT_IP_HEADER` (for example `cf-connecting-ip`) or adjust `TRUST_PROXY`.

`GET /healthz` reports `turn: off | secret | static | misconfigured`, so you can check TURN is set up.

### Why TURN

Voices go straight between browsers. About 1 in 5 connections (mobile data, office and university networks, some home routers) can't connect directly. TURN relays the audio for those people. Without it they show **No audio** in the room list.

### Option 1: your own server (app + HTTPS + TURN)

Any Linux VPS with Docker, a public IP and a domain. [docker-compose.yml](docker-compose.yml) runs the app, Caddy (automatic HTTPS certificates) and coturn.

1. Point two DNS A records at the server, for example `karaoke.example.com` and `turn.example.com`.
2. Open ports 80/tcp, 443/tcp+udp, 3478/tcp+udp and 49160–49200/udp in the firewall.
3. `cp .env.example .env`, then set `SESSION_SECRET`, `TURN_SECRET` (two different long random strings), `APP_DOMAIN`, `TURN_DOMAIN` and `PUBLIC_IP`.
4. `docker compose up -d --build`
5. Open `https://karaoke.example.com/healthz`. It should say `"turn":"secret"`.

The relay port range (49160–49200) covers about 20 people relayed at once. Widen it in `docker-compose.yml` and the firewall for more.

### Option 2: Render (no server to manage)

[render.yaml](render.yaml) sets up a Render web service with HTTPS (see *Put it online for free* above). Render can't run TURN, so sign up with a hosted TURN provider and fill `TURN_URLS`, `TURN_USERNAME` and `TURN_CREDENTIAL` in the Render dashboard. Fly.io, Railway and similar hosts work the same way with the [Dockerfile](Dockerfile); give them a volume mounted at `/data`.

### Checking TURN works

Open `chrome://webrtc-internals` during a call. A working relay shows a selected candidate pair of type `relay`. To force it while testing, connect one person over phone data.

## Files

- `Dockerfile`, `docker-compose.yml`, `deploy/Caddyfile`, `render.yaml` — hosting.
- `.github/workflows/pages.yml` — publishes `public/` to GitHub Pages, writing the server address into `config.js`.
- `public/config.js` — which server the front end talks to (empty = the same site).
- `server.js` — Express API (sign up, sign in, rooms, ICE/TURN config) and Socket.IO (room membership, WebRTC signalling, playback sync, recording indicators).
- `public/app.js` — routing, sign-in screens, home, public and private room screens.
- `public/room.js` — the room: mic, peer connections, YouTube player sync, recording and download.
- `public/styles.css` — design tokens and styles (design direction informed by the [Taste skill](https://www.tasteskill.dev/)).
