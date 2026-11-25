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
const EXPORT_MAX_BYTES = (Number(process.env.EXPORT_MAX_MB) || 600) * 1024 * 1024;
const EXPORT_MAX_JOBS = Number(process.env.EXPORT_MAX_JOBS) || 2;
let exportJobs = 0;

// ---------- storage ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!process.env.SESSION_SECRET && !fs.existsSync(SECRET_FILE)) fs.writeFileSync(SECRET_FILE, crypto.randomBytes(32).toString('hex'));
const SECRET = process.env.SESSION_SECRET || fs.readFileSync(SECRET_FILE, 'utf8').trim();

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
// Remove rooms that stay empty. New rooms get a grace period so the creator can join.
function scheduleCleanup(r, ms = 90_000) {
  clearTimeout(r.cleanupTimer);
  r.cleanupTimer = setTimeout(() => {
    if (r.members.size === 0) rooms.delete(r.code);
  }, ms);
}

// ---------- http ----------
const app = express();
app.disable('x-powered-by');
if (TRUST_PROXY > 0) app.set('trust proxy', TRUST_PROXY);

app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size, turn: TURN_MODE, store: STORE, cors: CORS_ORIGINS }));

if (FORCE_HTTPS) {
  app.use((req, res, next) => {
    if (req.secure) return next();
    res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
  });
}
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    // Mic for singing, camera for video chat, display capture for recording.
    'Permissions-Policy': 'microphone=(self), camera=(self), display-capture=(self), geolocation=()',
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

app.post('/api/signup', async (req, res) => {
  const { username, password } = req.body || {};
  const errors = {};
  if (!USERNAME_RE.test(username || '')) errors.username = 'Use 3–20 letters, numbers, dots, dashes or underscores.';
  if (typeof password !== 'string' || password.length < 6) errors.password = 'Use at least 6 characters.';
  if (!errors.username && users.some((u) => u.username.toLowerCase() === username.toLowerCase())) {
    errors.username = 'That name is taken. Try another.';
  }
  if (Object.keys(errors).length) return res.status(400).json({ errors });

  const user = {
    id: newUserId(),
    username,
    passHash: await bcrypt.hash(password, 10),
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

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = users.find((u) => u.username.toLowerCase() === String(username || '').toLowerCase());
  if (!user || !(await bcrypt.compare(String(password || ''), user.passHash))) {
    return res.status(401).json({ error: 'That name and password don’t match.' });
  }
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

app.post('/api/rooms', auth, (req, res) => {
  const { type, capacity, name } = req.body || {};
  if (type !== 'public' && type !== 'private') return res.status(400).json({ error: 'Pick public or private.' });
  let cap = PUBLIC_CAPACITY;
  if (type === 'private') {
    cap = Number(capacity);
    if (!Number.isInteger(cap) || cap < 5 || cap > 10) return res.status(400).json({ error: 'Private rooms hold 5 to 10 people.' });
  }
  const cleanName = String(name || '').trim().slice(0, 40) || `${req.user.username}’s room`;
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
    media: { videoId: null, title: null, playing: false, position: 0, at: Date.now() },
    recorders: new Set(),
    chat: [],
  };
  rooms.set(code, room);
  scheduleCleanup(room);
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

app.post('/api/export', auth, (req, res) => {
  if (exportJobs >= EXPORT_MAX_JOBS) return res.status(503).json({ error: 'The converter is busy. Try again in a minute.' });
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

app.get('/api/rooms/:code', auth, (req, res) => {
  const r = rooms.get(String(req.params.code).toUpperCase());
  if (!r) return res.status(404).json({ error: 'No room with that code. Check it and try again.' });
  res.json({ room: roomSummary(r) });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ---------- sockets ----------
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e5,
  ...(CORS_ORIGINS.length ? { cors: { origin: CORS_ORIGINS, methods: ['GET', 'POST'] } } : {}),
});

io.use((socket, next) => {
  const user = verifyToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!user) return next(new Error('unauthorized'));
  socket.data.user = user;
  next();
});

io.on('connection', (socket) => {
  const user = socket.data.user;
  let room = null;

  socket.on('time', (cb) => typeof cb === 'function' && cb(Date.now()));

  socket.on('join', ({ code } = {}, cb) => {
    if (typeof cb !== 'function') return;
    const r = rooms.get(String(code || '').toUpperCase());
    if (!r) return cb({ error: 'No room with that code. Check it and try again.' });
    if (room) return cb({ error: 'You’re already in a room.' });
    // Same account in a second tab: drop the old connection from the room.
    for (const [sid, m] of r.members) {
      if (m.userId === user.id) io.sockets.sockets.get(sid)?.disconnect(true);
    }
    if (r.members.size >= r.capacity) return cb({ error: `This room is full (${r.capacity} of ${r.capacity}).` });

    const peers = memberList(r);
    const state = { cam: false, mic: true };
    r.members.set(socket.id, { userId: user.id, username: user.username, ...state });
    clearTimeout(r.cleanupTimer);
    room = r;
    socket.join(r.code);
    socket.to(r.code).emit('peer-joined', { socketId: socket.id, userId: user.id, username: user.username, ...state });
    cb({
      room: roomSummary(r),
      peers,
      media: r.media,
      recorders: [...r.recorders],
      chat: r.chat,
      serverNow: Date.now(),
    });
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
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 500);
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
    if (!room || !room.members.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('media:load', ({ videoId, title } = {}) => {
    if (!room || typeof videoId !== 'string' || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) return;
    room.media = { videoId, title: String(title || '').slice(0, 120) || null, playing: false, position: 0, at: Date.now(), by: user.username };
    io.to(room.code).emit('media', { ...room.media, event: 'load' });
  });

  socket.on('media:title', ({ videoId, title } = {}) => {
    if (!room || room.media.videoId !== videoId) return;
    room.media.title = String(title || '').slice(0, 120) || null;
  });

  socket.on('media:control', ({ action, position } = {}) => {
    if (!room || !room.media.videoId) return;
    const pos = Math.max(0, Number(position) || 0);
    if (action === 'play') room.media = { ...room.media, playing: true, position: pos, at: Date.now() };
    else if (action === 'pause') room.media = { ...room.media, playing: false, position: pos, at: Date.now() };
    else if (action === 'seek') room.media = { ...room.media, position: pos, at: Date.now() };
    else if (action === 'ended') room.media = { ...room.media, playing: false, position: pos, at: Date.now() };
    else return;
    io.to(room.code).emit('media', { ...room.media, event: action, by: user.username });
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
      room.media.playing = false;
      scheduleCleanup(room, room.type === 'private' ? 10 * 60_000 : 30_000);
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
