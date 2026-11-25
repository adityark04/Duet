# Security

## Reporting a problem

Please don't open a public issue for security problems. Use GitHub's private reporting instead:
**Security** tab → **Report a vulnerability**. You'll get a reply as soon as possible.

## What Duet does to protect people

- **Passwords** are hashed with bcrypt; they're never stored or logged in plain text.
- **Sign-in tokens** are signed by the server and expire after 30 days.
- **Rate limits** on sign-up, sign-in, room creation, room-code lookups, recording conversion and every live event, so nobody can guess passwords or private room codes, or flood the server.
- **Caps** on accounts, open rooms, rooms per person and connections per network.
- **Voices and video** go directly between browsers (WebRTC, encrypted). The server only relays the connection set-up messages and never sees or stores the audio or video.
- **Chat** keeps only the last 50 messages per room, in memory; they disappear when the room closes.
- **Recordings** are converted and immediately deleted from the server; they're never kept.
- **Content Security Policy** and a pinned, integrity-checked Socket.IO script limit what code can run in the page.
- **Dependencies** are pinned (`package-lock.json`); Dependabot opens updates, including for the pinned GitHub Actions.

## If you run your own copy

- Set a long random `SESSION_SECRET`. Changing it signs everyone out.
- Keep `.env`, `data/` and your Upstash / TURN credentials out of git (they're in `.gitignore`).
- Set `CORS_ORIGINS` to exactly your front-end address.
- The limits can be tuned with environment variables; see the *Abuse protection* section of the README.
