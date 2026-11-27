// Duet — online karaoke server
// Express serves the app + a small JSON API; Socket.IO handles rooms,
// WebRTC signalling (voices go peer-to-peer) and YouTube playback sync.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const FORCE_HTTPS = /^(1|true|yes)$/i.test(process.env.FORCE_HTTPS || '');
// How many reverse proxies sit in front of the app (Caddy, Render, Fly…). 0 = none.
const TRUST_PROXY = Number(process.env.TRUST_PROXY ?? 1);

// ---------- abuse protection ----------
// Everything here is in memory (one server process). Numbers can be tuned with env vars.
const envInt = (name, def) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? Math.floor(n) : def; };
const CAPS = {
  accounts: envInt('MAX_ACCOUNTS', 10000),      // total sign-ups the server accepts
  rooms: envInt('MAX_ROOMS', 300),              // rooms open at once
  roomsPerUser: envInt('MAX_ROOMS_PER_USER', 3),// rooms one person can have open
  connPerIp: envInt('MAX_CONNECTIONS_PER_IP', 20),
  hashConcurrency: envInt('MAX_PASSWORD_CHECKS', 2), // bcrypt is CPU heavy; small free servers choke fast
  hashQueue: envInt('MAX_PASSWORD_QUEUE', 30),
};

// Fixed-window counter: at most `max` hits per `windowMs` per key.
class Limiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  hit(key) {
    const now = Date.now();
    let e = this.hits.get(key);
    if (!e || now >= e.reset) { e = { n: 0, reset: now + this.windowMs }; this.hits.set(key, e); }
    e.n++;
    return { ok: e.n <= this.max, retryAfter: Math.ceil((e.reset - now) / 1000) };
  }
  sweep() { const now = Date.now(); for (const [k, e] of this.hits) if (now >= e.reset) this.hits.delete(k); }
}
const MIN = 60_000;
const LIMIT = {
  api: new Limiter(envInt('RATE_API_PER_MIN', 300), MIN),            // per IP, every /api call
  signup: new Limiter(envInt('RATE_SIGNUP_PER_HOUR', 5), 60 * MIN),  // per IP
  loginIp: new Limiter(envInt('RATE_LOGIN_PER_15MIN', 20), 15 * MIN),// per IP
  loginName: new Limiter(10, 15 * MIN),                               // per username (slows password guessing)
  roomCreate: new Limiter(envInt('RATE_ROOMS_PER_HOUR', 10), 60 * MIN), // per user
  codeGuess: new Limiter(envInt('RATE_CODE_LOOKUPS_PER_10MIN', 30), 10 * MIN), // per user: room lookups + joins
  export: new Limiter(envInt('RATE_EXPORTS_PER_HOUR', 10), 60 * MIN), // per user
  connect: new Limiter(envInt('RATE_CONNECTS_PER_MIN', 30), MIN),    // per IP, socket connections
};
setInterval(() => Object.values(LIMIT).forEach((l) => l.sweep()), 5 * MIN).unref();

// The client's IP. Behind proxies, X-Forwarded-For is "client, proxy1, proxy2…" and only the
// entries added by our own proxies can be trusted, so count TRUST_PROXY hops from the right.
// CLIENT_IP_HEADER (e.g. "cf-connecting-ip") lets a platform header that clients can't forge win.
// On Render (which sets RENDER=true) traffic arrives via Cloudflare, then Render's balancer:
// X-Forwarded-For is "client, cloudflare, render". Cloudflare sets CF-Connecting-IP itself and
// rejects requests that try to supply it, so it's the reliable source there.
const CLIENT_IP_HEADER = (process.env.CLIENT_IP_HEADER || (process.env.RENDER ? 'cf-connecting-ip' : '')).toLowerCase();
function ipFrom(headers, remote) {
  if (CLIENT_IP_HEADER && headers[CLIENT_IP_HEADER]) return String(headers[CLIENT_IP_HEADER]).split(',')[0].trim();
  if (TRUST_PROXY > 0 && headers['x-forwarded-for']) {
    const chain = String(headers['x-forwarded-for']).split(',').map((s) => s.trim()).filter(Boolean);
    const i = chain.length - TRUST_PROXY;
    return chain[Math.max(0, i)] || remote || 'unknown';
  }
  return remote || 'unknown';
}
const reqIp = (req) => ipFrom(req.headers, req.socket.remoteAddress);

function tooMany(res, retryAfter, what = 'Too many attempts') {
  const mins = Math.max(1, Math.ceil(retryAfter / 60));
  res.set('Retry-After', String(retryAfter));
  return res.status(429).json({ error: `${what}. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` });
}
// Express middleware: limit by a key derived from the request.
const rateLimit = (limiter, keyOf, what) => (req, res, next) => {
  const r = limiter.hit(keyOf(req));
  return r.ok ? next() : tooMany(res, r.retryAfter, what);
};

// Password hashing gate: a few at a time, a short queue, then "busy" instead of melting the CPU.
let hashing = 0;
const hashWaiters = [];
async function withHashSlot(fn) {
  if (hashing >= CAPS.hashConcurrency) {
    if (hashWaiters.length >= CAPS.hashQueue) { const e = new Error('busy'); e.busy = true; throw e; }
    await new Promise((resolve) => hashWaiters.push(resolve));
  }
  hashing++;
  try { return await fn(); }
  finally { hashing--; hashWaiters.shift()?.(); }
}

// ---------- ICE / TURN ----------
// STUN finds a public address; TURN relays audio when two people can't reach
// each other directly (strict NATs, corporate or mobile networks).
//   TURN_URLS        comma-separated, e.g. "turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349"
//   TURN_SECRET      coturn "static-auth-secret": short-lived credentials are minted per user (preferred)
//   TURN_USERNAME / TURN_CREDENTIAL   fixed credentials (e.g. from a hosted TURN provider)
//   STUN_URLS        optional override, comma-separated
const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const STUN_URLS = splitList(process.env.STUN_URLS).length
  ? splitList(process.env.STUN_URLS)
  : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'];
const TURN_URLS = splitList(process.env.TURN_URLS);
const TURN_SECRET = process.env.TURN_SECRET || '';
const TURN_USERNAME = process.env.TURN_USERNAME || '';
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL || '';
const TURN_TTL = Number(process.env.TURN_TTL) || 12 * 3600;
const TURN_MODE = !TURN_URLS.length ? 'off' : TURN_SECRET ? 'secret' : TURN_USERNAME && TURN_CREDENTIAL ? 'static' : 'misconfigured';

function iceServersFor(userId) {
  const servers = [{ urls: STUN_URLS }];
  if (TURN_MODE === 'secret') {
    // coturn REST API scheme: username = "<expiry>:<user>", credential = base64(HMAC-SHA1(secret, username))
    const username = `${Math.floor(Date.now() / 1000) + TURN_TTL}:${userId}`;
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    servers.push({ urls: TURN_URLS, username, credential });
  } else if (TURN_MODE === 'static') {
    servers.push({ urls: TURN_URLS, username: TURN_USERNAME, credential: TURN_CREDENTIAL });
  }
  return servers;
}

// ---------- ffmpeg (turns browser WebM recordings into seekable MP4) ----------
let FFMPEG = process.env.FFMPEG_PATH || '';
if (!FFMPEG) { try { FFMPEG = require('ffmpeg-static'); } catch { FFMPEG = 'ffmpeg'; } }
// A 5-minute take is ~100 MB; 250 MB leaves room without letting one upload fill a small server's disk.
const EXPORT_MAX_BYTES = (Number(process.env.EXPORT_MAX_MB) || 250) * 1024 * 1024;
const EXPORT_MAX_JOBS = Number(process.env.EXPORT_MAX_JOBS) || 2;
let exportJobs = 0;

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!process.env.SESSION_SECRET && !fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'));
const SECRET = process.env.SESSION_SECRET || fs.readFileSync(SECRET_FILE, 'utf8').trim();

// Removes control characters, zero-width characters and text-direction overrides (which can make
// text display misleadingly), collapses whitespace and trims to `max`.
const cleanText = (v, max) => String(v ?? '')
  .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '')
  .replace(/\s+/g, ' ').trim().slice(0, max);

// Accounts live in memory and are persisted to either:
//  - Upstash Redis (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN): survives restarts on free
//    hosts whose disk is wiped, like Render's free plan; or
//  - data/users.json on local disk (default).
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const REDIS_KEY = process.env.REDIS_USERS_KEY || 'duet:users';
const STORE = REDIS_URL && REDIS_TOKEN ? 'redis' : 'file';

async function redis(...command) {
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) throw new Error(`Redis ${command[0]} failed: ${body.error || res.status}`);
  return body.result;
}

let users = [];
async function loadUsers() {
  if (STORE === 'redis') {
    const flat = (await redis('HGETALL', REDIS_KEY)) || [];
    users = [];
    for (let i = 1; i < flat.length; i += 2) { try { users.push(JSON.parse(flat[i])); } catch {} }
  } else {
    try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch { users = []; }
  }
}
async function saveUser(user) {
  if (STORE === 'redis') return redis('HSET', REDIS_KEY, user.id, JSON.stringify(user));
  // Write to a temp file then rename, so a crash mid-write can't corrupt the user list.
  const tmp = `${USERS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2));
  fs.renameSync(tmp, USERS_FILE);
}

// Sites allowed to call this server from another origin, e.g. the GitHub Pages front end.
const CORS_ORIGINS = splitList(process.env.CORS_ORIGINS).map((o) => o.replace(/\/+$/, ''));

const ALPHANUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const randomCode = (len) => Array.from(crypto.randomBytes(len), (b) => ALPHANUM[b % 36]).join('');

function newUserId() {
  let id;
  do { id = 'KR-' + randomCode(6); } while (users.some((u) => u.id === id));
  return id;
}

// ---------- tokens (stateless, HMAC signed) ----------
const TOKEN_DAYS = 30;
function signToken(userId) {
  const exp = Date.now() + TOKEN_DAYS * 864e5;
  const body = `${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, exp, sig] = parts;
  const expected = crypto.createHmac('sha256', SECRET).update(`${userId}.${exp}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Number(exp) < Date.now()) return null;
  return users.find((u) => u.id === userId) || null;
}
const publicUser = (u) => ({ id: u.id, username: u.username, createdAt: u.createdAt });

// ---------- rooms (in memory) ----------
/** @type {Map<string, any>} */
const rooms = new Map();
const PUBLIC_CAPACITY = 10;

function newRoomCode() {
  let code;
  do { code = randomCode(5); } while (rooms.has(code));
  return code;
}
function roomSummary(r) {
  return {
    code: r.code,
    name: r.name,
    type: r.type,
    capacity: r.capacity,
    members: r.members.size,
    hostName: r.hostName,
    nowPlaying: r.media.title || null,
    createdAt: r.createdAt,
  };
}
function memberList(r) {
  return [...r.members.entries()].map(([socketId, m]) => ({ socketId, userId: m.userId, username: m.username, cam: m.cam, mic: m.mic }));
}

// ---------- room lifecycle ----------
// A room is deleted once it has been empty for long enough:
//   never joined after creation  ROOM_UNUSED_MS        (default 90 s, time to share the code)
//   public room                  ROOM_IDLE_PUBLIC_MS   (default 30 s)
//   private room                 ROOM_IDLE_PRIVATE_MS  (default 10 min, so friends can drop and rejoin)
// One sweep enforces this (no per-room timers to get out of step), and also drops members whose
// connection no longer exists, so a crashed tab can never leave a ghost or keep a room alive.
const ROOM_UNUSED_MS = envInt('ROOM_UNUSED_MS', 90_000);
const ROOM_IDLE_PUBLIC_MS = envInt('ROOM_IDLE_PUBLIC_MS', 30_000);
const ROOM_IDLE_PRIVATE_MS = envInt('ROOM_IDLE_PRIVATE_MS', 10 * 60_000);
const ROOM_SWEEP_MS = envInt('ROOM_SWEEP_MS', 10_000);
const QUEUE_MAX = 25;

function idleLimit(r) {
  if (!r.everJoined) return ROOM_UNUSED_MS;
  return r.type === 'private' ? ROOM_IDLE_PRIVATE_MS : ROOM_IDLE_PUBLIC_MS;
}
// Where the song is now (media.at can be slightly in the future: a scheduled start).
const songPosition = (m) => (m.playing ? Math.max(0, m.position + ((Date.now() - m.at) / 1000) * (m.rate || 1)) : m.position);
// Pin the song at the point it had reached, so people who come back resume in the right place.
function freezeMedia(r) {
  if (!r.media.playing) return;
  r.media = { ...r.media, playing: false, position: songPosition(r.media), at: Date.now() };
}

// New songs start for everyone at the same moment, a beat from now, so every player has time
// to load it first (instead of loading paused and needing someone to press play).
const START_LEAD_MS = envInt('START_LEAD_MS', 1500);
const RATES = [0.5, 0.75, 1, 1.25, 1.5];

// ---------- party roles ----------
// The person who creates a room is its Leader (and an admin). Admins can make others admin,
// remove people, mute someone's chat, delete messages and set who may add songs, control
// the music and chat. If no admin is left in the room, the longest-present member becomes one.
const PERM_VALUES = ['everyone', 'admins'];
const isAdmin = (r, userId) => r.admins.has(userId);
const allowed = (r, userId, what) => r.perms[what] === 'everyone' || isAdmin(r, userId);
const rolesOf = (r) => ({ leaderId: r.hostId, admins: [...r.admins], perms: r.perms, chatMuted: [...r.chatMuted] });
function ensureAdmin(r) {
  if (!r.members.size) return;
  const present = [...r.members.values()];
  if (present.some((m) => r.admins.has(m.userId))) return;
  const next = present[0]; // Map keeps join order: the longest-present member
  r.admins.add(next.userId);
  io.to(r.code).emit('notice', { text: `${next.username} is now an admin (no admin was left in the room)` });
  io.to(r.code).emit('roles', rolesOf(r));
}
function deleteRoom(r) {
  rooms.delete(r.code);
  r.members.clear();
  r.chat.length = 0;
  r.queue.length = 0;
}
function sweepRooms() {
  const now = Date.now();
  for (const r of rooms.values()) {
    for (const sid of [...r.members.keys()]) {
      if (!io.sockets.sockets.has(sid)) {
        const m = r.members.get(sid);
        r.members.delete(sid);
        if (m && r.recorders.delete(m.username)) io.to(r.code).emit('recorders', [...r.recorders]);
        io.to(r.code).emit('peer-left', { socketId: sid });
      }
    }
    ensureAdmin(r);
    if (r.members.size === 0) {
      if (!r.emptySince) { r.emptySince = now; freezeMedia(r); }
      if (now - r.emptySince >= idleLimit(r)) deleteRoom(r);
    }
  }
}
// A person's open rooms: ones with people in them, or emptied only moments ago.
const roomsHeldBy = (userId) => [...rooms.values()].filter((r) => r.hostId === userId && (r.members.size > 0 || Date.now() - r.emptySince < ROOM_UNUSED_MS)).length;

// ---------- http ----------
const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY > 0) app.set('trust proxy', TRUST_PROXY);

app.get('/healthz', (req, res) => {
  let people = 0;
  for (const r of rooms.values()) people += r.members.size;
  res.json({ ok: true, rooms: rooms.size, people, connections: io.engine.clientsCount, turn: TURN_MODE, store: STORE, cors: CORS_ORIGINS });
});

if (FORCE_HTTPS) {
  app.use((req, res, next) => {
    if (req.secure) return next();
    res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
  });
}
// Content Security Policy: only our own scripts, the Socket.IO CDN build and YouTube's player.
// Kept in step with the <meta> CSP in public/index.html (used on GitHub Pages).
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://cdn.jsdelivr.net https://www.youtube.com https://s.ytimg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob: https://i.ytimg.com https://*.ytimg.com",
  "media-src 'self' blob:",
  "connect-src 'self' https: wss:",
  "frame-src https://www.youtube.com https://www.youtube-nocookie.com",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Mic for singing, camera for video chat, display capture for recording.
    'Permissions-Policy': 'microphone=(self), camera=(self), display-capture=(self), geolocation=()',
    'Content-Security-Policy': CSP,
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Resource-Policy': 'cross-origin',
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=15552000');
  next();
});

// Let the GitHub Pages front end (another origin) call the API. Auth is a Bearer token, no cookies.
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (origin && CORS_ORIGINS.includes(origin)) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
  }
  if (req.method === 'OPTIONS') return res.sendStatus(origin && CORS_ORIGINS.includes(origin) ? 204 : 403);
  next();
});
// After CORS, so a 429 still carries CORS headers and the page can show the message.
app.use('/api', rateLimit(LIMIT.api, reqIp, 'Too many requests'));

// What the server sees as your address (to check rate limiting works behind the host's proxies).
// Also lists the proxy headers that reached us (they only ever contain the caller's own address).
app.get('/api/whoami', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const seen = {};
  for (const h of ['x-forwarded-for', 'cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'x-envoy-external-address']) {
    if (req.headers[h]) seen[h] = String(req.headers[h]);
  }
  res.json({ ip: reqIp(req), via: CLIENT_IP_HEADER || (TRUST_PROXY > 0 ? `x-forwarded-for, ${TRUST_PROXY} hop(s)` : 'socket'), headers: seen });
});

app.use(express.json({ limit: '20kb' }));
// max-age 0 + ETag: browsers revalidate on each load, so new deploys show up immediately.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

function auth(req, res, next) {
  const header = req.get('authorization') || '';
  const user = verifyToken(header.replace(/^Bearer\s+/i, ''));
  if (!user) return res.status(401).json({ error: 'Please sign in again.' });
  req.user = user;
  next();
}

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,20}$/;
const PASSWORD_MAX = 128;
const BUSY = 'The server is busy right now. Try again in a few seconds.';
// Compared against when the name doesn't exist, so a wrong name takes as long as a wrong password
// (otherwise response time reveals which usernames exist).
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

app.post('/api/signup', rateLimit(LIMIT.signup, reqIp, 'Too many new accounts from your network'), async (req, res) => {
  const { username, password } = req.body || {};
  const errors = {};
  if (!USERNAME_RE.test(username || '')) errors.username = 'Use 3–20 letters, numbers, dots, dashes or underscores.';
  if (typeof password !== 'string' || password.length < 6) errors.password = 'Use at least 6 characters.';
  else if (password.length > PASSWORD_MAX) errors.password = `Use at most ${PASSWORD_MAX} characters.`;
  if (!errors.username && users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    errors.username = 'That name is taken. Try another.';
  }
  if (Object.keys(errors).length) return res.status(400).json({ errors });
  if (users.length >= CAPS.accounts) return res.status(503).json({ error: 'Sign-ups are closed for now. Try again later.' });

  let passHash;
  try { passHash = await withHashSlot(() => bcrypt.hash(password, 10)); }
  catch (err) { if (err.busy) return res.status(503).json({ error: BUSY }); throw err; }
  // Re-check: another request may have taken the name while we were hashing.
  if (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    return res.status(400).json({ errors: { username: 'That name is taken. Try another.' } });
  }
  const user = {
    id: newUserId(),
    username,
    passHash,
    createdAt: new Date().toISOString(),
  };
  users.push(user);
  try { await saveUser(user); }
  catch (err) {
    users = users.filter((u) => u !== user);
    console.error('Could not save account:', err.message);
    return res.status(503).json({ error: 'Couldn’t save your account right now. Try again in a moment.' });
  }
  res.json({ token: signToken(user.id), user: publicUser(user) });
});

app.post('/api/login', rateLimit(LIMIT.loginIp, reqIp, 'Too many sign-in attempts'), async (req, res) => {
  const { username, password } = req.body || {};
  const name = String(username || '').toLowerCase().slice(0, 40);
  const pw = String(password || '').slice(0, PASSWORD_MAX);
  const perName = LIMIT.loginName.hit(name);
  if (!perName.ok) return tooMany(res, perName.retryAfter, 'Too many sign-in attempts for this name');
  const user = users.find((u) => u.username.toLowerCase() === name);
  let ok;
  try { ok = await withHashSlot(() => bcrypt.compare(pw, user ? user.passHash : DUMMY_HASH)); }
  catch (err) { if (err.busy) return res.status(503).json({ error: BUSY }); throw err; }
  if (!user || !ok) return res.status(401).json({ error: 'That name and password don’t match.' });
  res.json({ token: signToken(user.id), user: publicUser(user) });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.get('/api/ice', auth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ iceServers: iceServersFor(req.user.id), ttl: TURN_MODE === 'secret' ? TURN_TTL : null });
});

app.get('/api/rooms/public', auth, (req, res) => {
  const list = [...rooms.values()]
    .filter((r) => r.type === 'public')
    .map(roomSummary)
    .sort((a, b) => b.members - a.members || b.createdAt - a.createdAt);
  res.json({ rooms: list });
});

const byUser = (req) => req.user.id;

app.post('/api/rooms', auth, rateLimit(LIMIT.roomCreate, byUser, 'You’ve opened a lot of rooms'), (req, res) => {
  const { type, capacity, name } = req.body || {};
  if (type !== 'public' && type !== 'private') return res.status(400).json({ error: 'Pick public or private.' });
  let cap = PUBLIC_CAPACITY;
  if (type === 'private') {
    cap = Number(capacity);
    if (!Number.isInteger(cap) || cap < 5 || cap > 10) return res.status(400).json({ error: 'Private rooms hold 5 to 10 people.' });
  }
  if (rooms.size >= CAPS.rooms) return res.status(503).json({ error: 'All the rooms are full right now. Try again in a little while.' });
  const mine = roomsHeldBy(req.user.id);
  if (mine >= CAPS.roomsPerUser) return res.status(429).json({ error: `You already have ${mine} rooms open. Use one of those, or wait a minute for an empty one to close.` });
  // Strip control characters and the like; the client also escapes everything it shows.
  const cleanName = cleanText(name, 40) || `${req.user.username}’s room`;
  const code = newRoomCode();
  const room = {
    code,
    name: cleanName,
    type,
    capacity: cap,
    hostId: req.user.id,
    hostName: req.user.username,
    createdAt: Date.now(),
    members: new Map(),
    media: { videoId: null, title: null, playing: false, position: 0, at: Date.now(), rate: 1 },
    recorders: new Set(),
    chat: [],
    queue: [],
    admins: new Set([req.user.id]),
    perms: { queue: 'everyone', playback: 'everyone', chat: 'everyone' },
    banned: new Set(),
    chatMuted: new Set(),
    everJoined: false,
    emptySince: Date.now(),
  };
  rooms.set(code, room);
  res.json({ room: roomSummary(room) });
});

// Upload a recording (raw MediaRecorder file), get back an MP4 (or M4A for voice-only takes).
// MediaRecorder files have no duration or seek index, so most players can't skip through them.
// When the browser already recorded H.264 / AAC, the streams are copied as-is (near instant,
// important on small free servers); otherwise they're re-encoded.
function exportArgs(kind, inPath, outPath, { copyVideo, copyAudio }) {
  const head = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inPath];
  const audio = copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
  if (kind === 'audio') return [...head, '-vn', ...audio, '-movflags', '+faststart', outPath];
  const video = copyVideo
    ? ['-c:v', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-r', '30'];
  return [...head, '-map', '0:v:0?', '-map', '0:a:0?', ...video, ...audio, '-movflags', '+faststart', outPath];
}

const exportingUsers = new Set();
app.post('/api/export', auth, rateLimit(LIMIT.export, byUser, 'You’ve converted a lot of recordings'), (req, res) => {
  if (exportJobs >= EXPORT_MAX_JOBS) return res.status(503).json({ error: 'The converter is busy. Try again in a minute.' });
  // One conversion per person at a time.
  if (exportingUsers.has(req.user.id)) return res.status(429).json({ error: 'Your last recording is still converting. Wait for it to finish.' });
  exportingUsers.add(req.user.id);
  res.on('close', () => exportingUsers.delete(req.user.id));
  const kind = req.query.kind === 'audio' ? 'audio' : 'video';
  const fast = { copyVideo: req.query.vcodec === 'h264', copyAudio: req.query.acodec === 'aac' };
  const declared = Number(req.get('content-length') || 0);
  if (declared > EXPORT_MAX_BYTES) return res.status(413).json({ error: 'That recording is too large to convert.' });

  exportJobs++;
  const id = crypto.randomUUID();
  const inPath = path.join(os.tmpdir(), `duet-${id}.webm`);
  const outPath = path.join(os.tmpdir(), `duet-${id}.${kind === 'audio' ? 'm4a' : 'mp4'}`);
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    exportJobs--;
    fs.rm(inPath, { force: true }, () => {});
    fs.rm(outPath, { force: true }, () => {});
  };
  const fail = (status, msg) => { if (!res.headersSent) res.status(status).json({ error: msg }); done(); };

  let bytes = 0;
  const file = fs.createWriteStream(inPath);
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > EXPORT_MAX_BYTES) { req.unpipe(file); file.destroy(); req.destroy(); fail(413, 'That recording is too large to convert.'); }
  });
  req.on('aborted', () => fail(400, 'Upload interrupted.'));
  req.pipe(file);
  file.on('error', () => fail(500, 'Could not save the upload.'));
  file.on('finish', () => {
    if (finished) return;
    if (bytes < 1000) return fail(400, 'The recording is empty.');
    let current = null;
    // Viewer gave up (closed the tab) before we answered: stop converting.
    res.on('close', () => { if (!res.writableFinished) current?.kill('SIGKILL'); });
    const run = (opts, isRetry) => {
      const ff = spawn(FFMPEG, exportArgs(kind, inPath, outPath, opts), { stdio: ['ignore', 'ignore', 'pipe'] });
      current = ff;
      let errText = '';
      ff.stderr.on('data', (d) => { errText = (errText + d).slice(-2000); });
      const killer = setTimeout(() => ff.kill('SIGKILL'), 15 * 60_000);
      ff.on('error', (err) => { clearTimeout(killer); console.error('ffmpeg failed to start:', err.message); fail(500, 'The MP4 converter is not available on this server.'); });
      ff.on('close', (code) => {
        clearTimeout(killer);
        if (finished) return;
        if (code !== 0) {
          // Stream copy can fail on odd inputs: fall back to a full re-encode once.
          if (!isRetry && (opts.copyVideo || opts.copyAudio)) return run({ copyVideo: false, copyAudio: false }, true);
          console.error('ffmpeg error:', errText.trim());
          return fail(500, 'Could not convert this recording.');
        }
        res.type(kind === 'audio' ? 'audio/mp4' : 'video/mp4');
        res.sendFile(outPath, (err) => { if (err) console.error('send failed:', err.message); done(); });
      });
    };
    run(fast, false);
  });
});

// Rate limited per person so nobody can sweep through codes to find private rooms.
app.get('/api/rooms/:code', auth, rateLimit(LIMIT.codeGuess, byUser, 'Too many room codes tried'), (req, res) => {
  const r = rooms.get(String(req.params.code).toUpperCase().slice(0, 5));
  if (!r) return res.status(404).json({ error: 'No room with that code. Check it and try again.' });
  res.json({ room: roomSummary(r) });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- sockets ----------
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5,
  // Notice a vanished connection (closed laptop, lost Wi-Fi) within ~20 s instead of ~45 s.
  pingInterval: envInt('PING_INTERVAL_MS', 10_000),
  pingTimeout: envInt('PING_TIMEOUT_MS', 10_000),
  ...(CORS_ORIGINS.length ? { cors: { origin: CORS_ORIGINS, methods: ['GET', 'POST'] } } : {}),
});
setInterval(sweepRooms, ROOM_SWEEP_MS).unref();

// Recordings are deleted right after conversion; this catches any left by a crash mid-conversion.
function sweepTempFiles() {
  const dir = os.tmpdir();
  fs.readdir(dir, (err, names) => {
    if (err) return;
    for (const n of names) {
      if (!/^duet-[0-9a-f-]{36}\.(webm|mp4|m4a)$/.test(n)) continue;
      const p = path.join(dir, n);
      fs.stat(p, (e, st) => { if (!e && Date.now() - st.mtimeMs > 60 * 60_000) fs.rm(p, { force: true }, () => {}); });
    }
  });
}
sweepTempFiles();
setInterval(sweepTempFiles, 30 * 60_000).unref();

// The "Up next" list: advance to the next song (when one ends, or someone skips).
function playNext(r, by) {
  const next = r.queue.shift();
  if (!next) return false;
  r.media = { videoId: next.videoId, title: next.title, playing: true, position: 0, at: Date.now() + START_LEAD_MS, rate: 1, by: next.by || by };
  io.to(r.code).emit('media', { ...r.media, event: 'next' });
  io.to(r.code).emit('queue', r.queue);
  return true;
}

// Open connections per IP (a household or office shares one IP, so the cap is generous).
const connsByIp = new Map();

io.use((socket, next) => {
  const ip = ipFrom(socket.handshake.headers, socket.handshake.address);
  if (!LIMIT.connect.hit(ip).ok) return next(new Error('rate-limited'));
  if ((connsByIp.get(ip) || 0) >= CAPS.connPerIp) return next(new Error('too-many-connections'));
  const user = verifyToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  socket.data.ip = ip;
  connsByIp.set(ip, (connsByIp.get(ip) || 0) + 1);
  socket.on('disconnect', () => {
    const n = (connsByIp.get(ip) || 1) - 1;
    if (n > 0) connsByIp.set(ip, n); else connsByIp.delete(ip);
  });
  next();
});

// Token bucket: `rate` events per second on average, bursts up to `burst`.
function bucket(rate, burst) {
  let tokens = burst;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(burst, tokens + ((now - last) / 1000) * rate);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}
// Per-event budgets. Signalling bursts while a call connects (ICE candidates), so it gets the most.
const EVENT_BUDGET = {
  signal: [30, 150],
  'media:control': [2, 6],
  'media:load': [0.2, 3],
  'media:title': [0.5, 3],
  state: [2, 8],
  react: [2, 6],
  rec: [0.5, 4],
  chat: [1.5, 6],
  join: [0.2, 3],
  time: [2, 10],
  leave: [1, 3],
  'queue:add': [0.5, 5],
  'queue:remove': [1, 5],
  'queue:next': [0.3, 3],
  'admin:role': [1, 5],
  'admin:mute': [1, 5],
  'admin:kick': [0.5, 4],
  'admin:perms': [1, 5],
  'admin:chat-delete': [2, 8],
  'admin:chat-clear': [0.2, 2],
};

io.on('connection', (socket) => {
  const user = socket.data.user;
  let room = null;

  // Drop events over budget; disconnect a socket that keeps flooding.
  const buckets = {};
  const overall = bucket(40, 200);
  let dropped = 0;
  let droppedSince = Date.now();
  socket.use((packet, next) => {
    const [event] = packet;
    const spec = EVENT_BUDGET[event];
    if (!spec) return; // unknown event: ignore silently
    buckets[event] ||= bucket(...spec);
    if (overall() && buckets[event]()) return next();
    // Requests that expect an answer (like join) always get one, so nothing waits forever.
    const reply = packet[packet.length - 1];
    if (typeof reply === 'function') reply({ error: 'Too many requests at once. Wait a moment and try again.' });
    if (Date.now() - droppedSince > 10_000) { dropped = 0; droppedSince = Date.now(); }
    // Chat gets its own wording, so a dropped message isn't a mystery.
    if (event === 'chat') socket.emit('chat-error', { error: 'Slow down a little. Some messages weren’t sent.' });
    else if (++dropped === 1) socket.emit('slow-down');
    if (event === 'chat') dropped++;
    if (dropped > 300) socket.disconnect(true);
  });

  socket.on('time', (cb) => typeof cb === 'function' && cb(Date.now()));

  socket.on('join', ({ code } = {}, cb) => {
    if (typeof cb !== 'function') return;
    // Same per-person budget as code lookups, so joins can't be used to guess private codes either.
    const guess = LIMIT.codeGuess.hit(user.id);
    if (!guess.ok) return cb({ error: `Too many room codes tried. Try again in ${Math.ceil(guess.retryAfter / 60)} minutes.` });
    const r = rooms.get(String(code || '').toUpperCase().slice(0, 5));
    if (!r) return cb({ error: 'No room with that code. Check it and try again.' });
    if (room) return cb({ error: 'You’re already in a room.' });
    if (r.banned.has(user.id)) return cb({ error: 'An admin removed you from this room.' });
    // Same account in a second tab: drop the old connection from the room.
    for (const [sid, m] of r.members) {
      if (m.userId === user.id) io.sockets.sockets.get(sid)?.disconnect(true);
    }
    if (r.members.size >= r.capacity) return cb({ error: `This room is full (${r.capacity} of ${r.capacity}).` });

    const peers = memberList(r);
    const state = { cam: false, mic: true };
    r.members.set(socket.id, { userId: user.id, username: user.username, ...state });
    r.everJoined = true;
    r.emptySince = null;
    room = r;
    socket.join(r.code);
    socket.to(r.code).emit('peer-joined', { socketId: socket.id, userId: user.id, username: user.username, ...state });
    cb({
      room: roomSummary(r),
      peers,
      media: r.media,
      recorders: [...r.recorders],
      chat: r.chat,
      queue: r.queue,
      roles: rolesOf(r),
      serverNow: Date.now(),
    });
    ensureAdmin(r);
  });

  // Camera / mic on-off, so others can show a video tile or a muted badge.
  socket.on('state', ({ cam, mic } = {}) => {
    if (!room) return;
    const m = room.members.get(socket.id);
    if (!m) return;
    if (typeof cam === 'boolean') m.cam = cam;
    if (typeof mic === 'boolean') m.mic = mic;
    socket.to(room.code).emit('peer-state', { socketId: socket.id, cam: m.cam, mic: m.mic });
  });

  // Live text chat. Last 50 messages are kept so late joiners see the conversation.
  const chatTimes = [];
  socket.on('chat', ({ text } = {}) => {
    if (!room || typeof text !== 'string') return;
    if (!allowed(room, user.id, 'chat')) return socket.emit('chat-error', { error: 'Only admins can chat right now.' });
    if (room.chatMuted.has(user.id)) return socket.emit('chat-error', { error: 'An admin has muted you in chat.' });
    const clean = cleanText(text, 500);
    if (!clean) return;
    const now = Date.now();
    while (chatTimes.length && now - chatTimes[0] > 5000) chatTimes.shift();
    if (chatTimes.length >= 6) return socket.emit('chat-error', { error: 'Slow down a little.' });
    chatTimes.push(now);
    const msg = { id: crypto.randomUUID(), userId: user.id, username: user.username, text: clean, at: now };
    room.chat.push(msg);
    if (room.chat.length > 50) room.chat.shift();
    io.to(room.code).emit('chat', msg);
  });

  // WebRTC signalling relay — only between members of the same room.
  socket.on('signal', ({ to, data } = {}) => {
    if (!room || typeof to !== 'string' || to === socket.id || !room.members.has(to)) return;
    if (!data || typeof data !== 'object') return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  const deny = (msg) => socket.emit('chat-error', { error: msg });

  // "Play now": the new song starts for everyone together, START_LEAD_MS from now.
  socket.on('media:load', ({ videoId, title } = {}) => {
    if (!room || typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return;
    if (!allowed(room, user.id, 'playback')) return deny('Only admins can change the song right now. Add it to Up next instead.');
    room.media = { videoId, title: cleanText(title, 120) || null, playing: true, position: 0, at: Date.now() + START_LEAD_MS, rate: 1, by: user.username };
    io.to(room.code).emit('media', { ...room.media, event: 'load' });
  });

  socket.on('media:title', ({ videoId, title } = {}) => {
    if (!room || room.media.videoId !== videoId) return;
    room.media.title = cleanText(title, 120) || null;
  });

  socket.on('media:control', ({ action, position, videoId, rate } = {}) => {
    if (!room || !room.media.videoId) return;
    const pos = Math.min(24 * 3600, Math.max(0, Number(position) || 0));
    if (action === 'ended') {
      // Automatic, from everyone's player: always allowed, but only the first report for the song counts.
      if (videoId && videoId !== room.media.videoId) return;
      if (!room.media.playing) return;
      if (playNext(room, user.username)) return;
      room.media = { ...room.media, playing: false, position: pos, at: Date.now() };
    } else {
      if (!allowed(room, user.id, 'playback')) return deny('Only admins can control the music right now.');
      if (action === 'play') room.media = { ...room.media, playing: true, position: pos, at: Date.now() };
      else if (action === 'pause') room.media = { ...room.media, playing: false, position: pos, at: Date.now() };
      else if (action === 'seek') room.media = { ...room.media, position: pos, at: Date.now() };
      else if (action === 'rate') {
        const r = Number(rate);
        if (!RATES.includes(r)) return;
        // re-anchor at the current point so the speed change doesn't jump anyone
        room.media = { ...room.media, position: songPosition(room.media), at: Date.now(), rate: r };
      } else return;
    }
    // `by` stays the person who added the song; `actor` is who just pressed something.
    io.to(room.code).emit('media', { ...room.media, event: action, actor: user.username });
  });

  // ---- Up next ----
  socket.on('queue:add', ({ videoId, title } = {}) => {
    if (!room || typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return;
    if (!allowed(room, user.id, 'queue')) return deny('Only admins can add songs right now.');
    if (room.queue.length >= QUEUE_MAX) return deny(`The list holds ${QUEUE_MAX} songs. Play or remove some first.`);
    const item = { id: crypto.randomUUID().slice(0, 8), videoId, title: cleanText(title, 120) || null, by: user.username, byId: user.id };
    // Nothing on yet: start it for everyone straight away.
    if (!room.media.videoId) {
      room.media = { videoId, title: item.title, playing: true, position: 0, at: Date.now() + START_LEAD_MS, rate: 1, by: user.username };
      io.to(room.code).emit('media', { ...room.media, event: 'load' });
      return;
    }
    room.queue.push(item);
    io.to(room.code).emit('queue', room.queue);
  });
  socket.on('queue:remove', ({ id } = {}) => {
    if (!room) return;
    const i = room.queue.findIndex((q) => q.id === id);
    if (i < 0) return;
    // You can always take back your own song; other people's need queue rights.
    if (room.queue[i].byId !== user.id && !allowed(room, user.id, 'queue')) return deny('Only admins can remove other people’s songs right now.');
    room.queue.splice(i, 1);
    io.to(room.code).emit('queue', room.queue);
  });
  socket.on('queue:next', () => {
    if (!room) return;
    if (!allowed(room, user.id, 'playback')) return deny('Only admins can skip songs right now.');
    if (!playNext(room, user.username)) deny('Nothing in Up next yet.');
  });

  // ---- admin tools ----
  const leaderId = () => room?.hostId;
  const memberSockets = (userId) => [...room.members.entries()].filter(([, m]) => m.userId === userId).map(([sid]) => sid);
  const nameOf = (userId) => [...room.members.values()].find((m) => m.userId === userId)?.username || 'Someone';
  const adminCheck = (targetId) => {
    if (!room || !isAdmin(room, user.id)) { deny('Only admins can do that.'); return false; }
    if (targetId === undefined) return true;
    if (typeof targetId !== 'string' || !memberSockets(targetId).length) { deny('That person isn’t in the room any more.'); return false; }
    if (targetId === leaderId()) { deny('The party leader can’t be changed.'); return false; }
    // Admins can manage members; acting on another admin is for the leader only.
    if (isAdmin(room, targetId) && user.id !== leaderId()) { deny('Only the party leader can do that to another admin.'); return false; }
    return true;
  };
  socket.on('admin:role', ({ userId, admin } = {}) => {
    if (!room || !isAdmin(room, user.id)) return deny('Only admins can do that.');
    if (admin === true) {
      if (typeof userId !== 'string' || !memberSockets(userId).length) return deny('That person isn’t in the room any more.');
      room.admins.add(userId);
      room.chatMuted.delete(userId);
      io.to(room.code).emit('notice', { text: `${user.username} made ${nameOf(userId)} an admin` });
    } else {
      if (!adminCheck(userId)) return;
      if (user.id !== leaderId()) return deny('Only the party leader can remove an admin.');
      room.admins.delete(userId);
      io.to(room.code).emit('notice', { text: `${nameOf(userId)} is no longer an admin` });
    }
    io.to(room.code).emit('roles', rolesOf(room));
  });
  socket.on('admin:mute', ({ userId, muted } = {}) => {
    if (!adminCheck(userId)) return;
    if (muted) room.chatMuted.add(userId); else room.chatMuted.delete(userId);
    io.to(room.code).emit('notice', { text: `${user.username} ${muted ? 'muted' : 'unmuted'} ${nameOf(userId)} in chat` });
    io.to(room.code).emit('roles', rolesOf(room));
  });
  socket.on('admin:kick', ({ userId } = {}) => {
    if (!adminCheck(userId)) return;
    const name = nameOf(userId);
    room.banned.add(userId);
    room.admins.delete(userId);
    for (const sid of memberSockets(userId)) {
      const s = io.sockets.sockets.get(sid);
      s?.emit('kicked', { by: user.username });
      s?.disconnect(true); // runs their leave(): peers are told, cleanup happens
    }
    io.to(room.code).emit('notice', { text: `${user.username} removed ${name} from the room` });
    io.to(room.code).emit('roles', rolesOf(room));
  });
  socket.on('admin:perms', (p = {}) => {
    if (!room || !isAdmin(room, user.id)) return deny('Only admins can change room settings.');
    for (const k of ['queue', 'playback', 'chat']) if (PERM_VALUES.includes(p[k])) room.perms[k] = p[k];
    io.to(room.code).emit('roles', rolesOf(room));
    io.to(room.code).emit('notice', { text: `${user.username} updated the room settings` });
  });
  socket.on('admin:chat-delete', ({ id } = {}) => {
    if (!room || !isAdmin(room, user.id)) return deny('Only admins can delete messages.');
    const i = room.chat.findIndex((m) => m.id === id);
    if (i < 0) return;
    room.chat.splice(i, 1);
    io.to(room.code).emit('chat-deleted', { id });
  });
  socket.on('admin:chat-clear', () => {
    if (!room || !isAdmin(room, user.id)) return deny('Only admins can clear the chat.');
    room.chat.length = 0;
    io.to(room.code).emit('chat-cleared', { by: user.username });
  });

  socket.on('rec', ({ on } = {}) => {
    if (!room) return;
    if (on) room.recorders.add(user.username); else room.recorders.delete(user.username);
    io.to(room.code).emit('recorders', [...room.recorders]);
  });

  socket.on('react', ({ emoji } = {}) => {
    if (!room || !['👏', '🔥', '❤️', '🎤', '😂'].includes(emoji)) return;
    io.to(room.code).emit('react', { emoji, username: user.username });
  });

  const leave = () => {
    if (!room) return;
    room.members.delete(socket.id);
    if (room.recorders.delete(user.username)) io.to(room.code).emit('recorders', [...room.recorders]);
    socket.to(room.code).emit('peer-left', { socketId: socket.id });
    socket.leave(room.code);
    if (room.members.size === 0) {
      room.emptySince = Date.now();
      freezeMedia(room);
    } else {
      ensureAdmin(room);
    }
    room = null;
  };
  socket.on('leave', leave);
  socket.on('disconnect', leave);
});

loadUsers()
  .then(() => {
    server.listen(PORT, HOST, () => {
      console.log(`Duet karaoke running at http://localhost:${PORT}`);
      console.log(`  accounts: ${STORE === 'redis' ? 'Upstash Redis' : DATA_DIR} (${users.length} loaded)`);
      console.log(`  TURN: ${TURN_MODE}${TURN_MODE === 'misconfigured' ? ' (TURN_URLS set but no TURN_SECRET or TURN_USERNAME/TURN_CREDENTIAL; relaying disabled)' : ''}`);
      console.log(`  allowed front ends: ${CORS_ORIGINS.length ? CORS_ORIGINS.join(', ') : 'same origin only'}`);
      if (!process.env.SESSION_SECRET && STORE === 'redis') console.warn('  warning: set SESSION_SECRET, or everyone is signed out whenever the disk is wiped');
    });
  })
  .catch((err) => {
    console.error('Could not load accounts:', err.message);
    process.exit(1);
  });

const shutdown = () => {
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
