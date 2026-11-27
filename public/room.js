import { esc, toast, copy, colorFor, initials, api, apiFetch, API_BASE } from './app.js?v=14';

// Fallback if the server's ICE config can't be fetched. The server adds TURN when configured.
const DEFAULT_ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
let ICE = DEFAULT_ICE;
let iceFetchedAt = 0;
async function loadIce() {
  // TURN credentials are short-lived; refresh at most every 30 minutes.
  if (Date.now() - iceFetchedAt < 30 * 60_000) return;
  try {
    const { iceServers } = await api('/api/ice');
    if (Array.isArray(iceServers) && iceServers.length) { ICE = { iceServers }; iceFetchedAt = Date.now(); }
  } catch { ICE = DEFAULT_ICE; }
}

const I = {
  play: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6 4.5v11a.8.8 0 0 0 1.2.7l8.6-5.5a.8.8 0 0 0 0-1.4L7.2 3.8A.8.8 0 0 0 6 4.5Z"/></svg>',
  pause: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="5" y="4" width="3.5" height="12" rx="1"/><rect x="11.5" y="4" width="3.5" height="12" rx="1"/></svg>',
  restart: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10a6 6 0 1 0 2-4.5"/><path d="M4 3.5V7h3.5"/></svg>',
  mic: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="7" y="2.5" width="6" height="10" rx="3"/><path d="M4.5 10a5.5 5.5 0 0 0 11 0M10 15.5V18"/></svg>',
  micOff: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M13 9V5.5a3 3 0 0 0-5.6-1.5M7 8v1.5a3 3 0 0 0 4.6 2.5M4.5 10a5.5 5.5 0 0 0 9 4.2M15.5 10c0 .6-.1 1.2-.3 1.7M10 15.5V18M3 3l14 14"/></svg>',
  cam: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="2.5" y="5" width="11" height="10" rx="2"/><path d="M13.5 8.5 17.5 6v8l-4-2.5"/></svg>',
  camOff: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 5h4.5a2 2 0 0 1 2 2v1.5L17.5 6v8l-1.2-.75M13.5 13v0a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V7a2 2 0 0 1 1.3-1.9M3 3l14 14"/></svg>',
  rec: '<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="5.5" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="2"/></svg>',
  copy: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M13 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/></svg>',
  info: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.5"/><path d="M8 7.2V11M8 5v.2"/></svg>',
  leave: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-3M8 14l-4-4 4-4M4 10h9"/></svg>',
  send: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 10h11M10 4.5l5.5 5.5-5.5 5.5"/></svg>',
  skip: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 4.5v11l8-5.5-8-5.5Z" fill="currentColor"/><path d="M15.5 4.5v11"/></svg>',
  x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg>',
};

// YouTube title for a video ID, for the Up next list. Best effort: when the lookup refuses
// or fails, the song still goes in and the player fills the title in once it loads.
const infoCache = new Map();
async function videoInfo(id) {
  if (infoCache.has(id)) return infoCache.get(id);
  let info = { title: null };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) info = { title: String((await res.json()).title || '').slice(0, 120) || null };
  } catch { /* offline, slow or refused: carry on without a title */ }
  if (info.title) infoCache.set(id, info);
  return info;
}
const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'touchend', 'keydown'];

// Can this browser record the backing music? That needs tab-audio capture, which only
// Chrome and Edge on a computer have. Everywhere else, recordings are voices only.
const CAN_RECORD_MUSIC = (() => {
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  const chromium = /Chrome\/|Edg\//.test(ua) && !/OPR\/|SamsungBrowser/.test(ua);
  return !!navigator.mediaDevices?.getDisplayMedia && chromium && !mobile;
})();

const thumb = (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;

const fmt = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function parseYouTube(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    const host = u.hostname.replace(/^www\.|^m\.|^music\./, '');
    if (host === 'youtu.be') return u.pathname.slice(1, 12) || null;
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      const v = u.searchParams.get('v');
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

let ytReady;
function loadYouTubeAPI() {
  if (ytReady) return ytReady;
  ytReady = new Promise((resolve) => {
    if (window.YT && window.YT.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev && prev(); resolve(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  });
  return ytReady;
}

export function mountRoom(main, { solo = false, code = null, me, token }) {
  // ---------- state ----------
  const S = {
    socket: null,
    peers: new Map(), // socketId -> { pc, username, userId, audio, stream, videoStream, analyser, pending, state, cam, mic, videoSender }
    pendingInfo: new Map(),
    localStream: null,
    micMuted: false,
    camTrack: null,
    camStream: null,
    ctx: null,
    localAnalyser: null,
    player: null,
    playerReady: false,
    loadedId: null,
    media: { videoId: null, title: null, playing: false, position: 0, at: Date.now() },
    offset: 0, // serverTime - localTime
    recorders: [],
    rec: null,
    hold: false, // playback paused locally while the "save recording" dialog is open
    levels: new Map(), // tile key -> current voice level 0..1
    timers: [],
    raf: 0,
    disposed: false,
    room: solo ? { name: 'Solo session', type: 'solo', capacity: 1, code: null } : null,
    blocked: false,
  };
  const serverNow = () => Date.now() + S.offset;
  const expectedPos = (m = S.media) => (m.playing ? m.position + (serverNow() - m.at) / 1000 : m.position);

  main.innerHTML = `
    <section class="room">
      <div class="wrap">
        <div class="room__top">
          <div class="room__title">
            <span class="label" id="r-kind">${solo ? 'Solo' : 'Connecting…'}</span>
            <h1 id="r-name">${solo ? 'Solo <em>spotlight</em>' : 'Joining room…'}</h1>
          </div>
          <div class="controls">
            ${solo ? '' : `<div class="codechip" id="r-codechip" hidden><span class="label">Room code</span><span class="mono" id="r-code"></span><button class="btn btn--quiet btn--sm iconbtn" style="width:36px;height:36px" type="button" id="r-copycode" aria-label="Copy room code">${I.copy}</button></div>
            <button class="btn btn--line" type="button" id="r-share" hidden>Copy invite link</button>`}
            <a class="btn btn--quiet" href="#/" id="r-leave">${I.leave} Leave</a>
          </div>
        </div>

        <div class="room__grid">
          <div class="room__main">
            <div class="stage">
              <div class="screen" id="r-screen">
                <div class="screen__player"><div id="r-player"></div></div>
                <div class="screen__empty" id="r-empty">
                  <div class="screen__empty-inner">
                    <div class="eq eq--accent" aria-hidden="true" style="height:48px"><i></i><i></i><i></i><i></i><i></i></div>
                    <h2 style="font-size:30px">Put a record <em>on</em></h2>
                    <p>Choose a video that already shows the lyrics on screen. Searching “song name karaoke” or “song name lyrics” on YouTube works well.</p>
                  </div>
                </div>
                <button class="screen__shield" id="r-shield" type="button" aria-label="Play or pause" hidden></button>
                <div class="reactions" id="r-reacts" aria-hidden="true"></div>
                <div class="screen__badge" id="r-recbadge" hidden><span class="recdot"></span><span id="r-recnames"></span></div>
              </div>
              <div class="deck">
                <div class="progress">
                  <span id="r-cur">0:00</span>
                  <div class="bar" id="r-bar" role="slider" tabindex="0" aria-label="Song position" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"><div class="bar__track"><div class="bar__fill" id="r-fill"></div></div></div>
                  <span id="r-dur">0:00</span>
                </div>
                <div class="transport">
                  <button class="btn btn--primary btn--round" type="button" id="r-play" aria-label="Play" disabled>${I.play}</button>
                  <div class="nowplaying"><span class="nowplaying__t" id="r-title">Nothing on the turntable yet</span><span class="nowplaying__k" id="r-by">Add a song from Up next</span></div>
                  <div class="transport__right">
                    <button class="btn btn--tonal iconbtn" type="button" id="r-restart" aria-label="Start from the beginning" disabled>${I.restart}</button>
                    <button class="btn btn--tonal iconbtn" type="button" id="r-skip" aria-label="Skip to the next song" disabled>${I.skip}</button>
                  </div>
                </div>
                <div class="deck__foot">
                  <p class="tip">${I.info}<span><strong>Pick a lyrics or karaoke video.</strong> ${solo ? 'Headphones keep the music out of your mic.' : 'Wear headphones so the music doesn’t echo back to the room.'}</span></p>
                  <button class="btn btn--line btn--rec" type="button" id="r-rec" aria-pressed="false" disabled>${I.rec}<span>Record song</span></button>
                </div>
              </div>
            </div>

            <section class="card faces" aria-labelledby="r-faces-h">
              <div class="section-head">
                <div style="display:grid;gap:2px"><h2 id="r-faces-h">${solo ? 'You on <em>camera</em>' : 'On <em>stage</em>'}</h2><span class="label" id="r-count">${solo ? 'This is what your recording shows' : ''}</span></div>
                <div class="controls">
                  <button class="btn btn--tonal iconbtn" type="button" id="r-mic" aria-label="Mute microphone" aria-pressed="false">${I.mic}</button>
                  <button class="btn btn--tonal iconbtn" type="button" id="r-cam" aria-label="Turn camera on" aria-pressed="false">${I.camOff}</button>
                </div>
              </div>
              <div class="tiles" id="r-tiles"></div>
              <p id="r-micwarn" hidden class="person__state person__state--warn" style="font-size:14px"></p>
            </section>
          </div>

          <aside class="side">
            <div class="card upnext">
              <div class="card__head"><h2>Up next</h2><span class="label" id="r-qcount"></span></div>
              <ol class="queue" id="r-queue" aria-label="Songs in the queue"></ol>
              <form class="queue__add" id="r-load" novalidate>
                <label for="r-url" style="position:absolute;left:-9999px">YouTube link</label>
                <input class="input" id="r-url" placeholder="Paste a YouTube link" autocomplete="off" inputmode="url">
                <div class="queue__btns">
                  <button class="btn btn--tonal" type="submit" value="queue">Add to Up next</button>
                  <button class="btn btn--line" type="submit" value="now">Play now</button>
                </div>
              </form>
            </div>
            ${solo ? '' : `<div class="card chat">
              <div class="card__head"><h2>Live chat</h2><span class="label" id="r-chatcount"></span></div>
              <ol class="chat__list" id="r-chat" aria-live="polite" aria-label="Chat messages">
                <li class="msg msg--sys">Say hi. Messages stay in this room only.</li>
              </ol>
              <form class="chat__form" id="r-chatform" novalidate>
                <label for="r-chatinput" style="position:absolute;left:-9999px">Message</label>
                <input class="input" id="r-chatinput" maxlength="500" placeholder="Say something nice…" autocomplete="off">
                <button class="btn btn--tonal iconbtn" type="submit" aria-label="Send message">${I.send}</button>
              </form>
              <div class="react-row" id="r-reactrow">${['👏', '🔥', '❤️', '🎤', '😂'].map((e) => `<button type="button" data-e="${e}" aria-label="Send ${e}">${e}</button>`).join('')}</div>
            </div>`}
            <div class="card">
              <div class="card__head"><h2>How recording works</h2></div>
              <ol class="steps">
                <li>Turn your camera on in <strong>${solo ? 'You on camera' : 'On stage'}</strong>. That panel is what gets filmed.</li>
                <li>Press <strong>Record song</strong>. To keep the music, pick <strong>this tab</strong> and switch on <strong>Also share tab audio</strong>.</li>
                <li>The song starts from the top${solo ? '' : ' for everyone'}. Sing.</li>
                <li>When it ends, download your karaoke as an MP4.</li>
              </ol>
            </div>
          </aside>
        </div>
      </div>
      <div id="r-audio" hidden></div>
    </section>

    <dialog id="d-rec" aria-labelledby="d-rec-h">
      <form method="dialog" class="dlg">
        <div style="display:grid;gap:8px"><h2 id="d-rec-h" style="font-size:28px">Record this song</h2>
        <p class="muted">The video shows ${solo ? 'you' : 'everyone'} from the <strong>${solo ? 'You on camera' : 'Voice &amp; video'}</strong> panel, with ${solo ? 'your voice' : 'all the voices'}. Turn your camera on to be seen; otherwise your initials show.</p></div>
        <div class="checks">
          ${CAN_RECORD_MUSIC
            ? '<label class="check"><input type="checkbox" id="d-rec-music" checked><span><strong>Include the backing music</strong><small>Your browser asks what to share. Pick <strong>this tab</strong> and turn on <strong>Also share tab audio</strong>. Wear headphones so the music isn’t picked up twice.</small></span></label>'
            : '<label class="check check--off"><input type="checkbox" id="d-rec-music" disabled><span><strong>Backing music not available here</strong><small>This browser can’t capture the song’s sound, so the recording will have the voices only. To include the music, record from Chrome or Edge on a computer.</small></span></label>'}
          <label class="check"><input type="checkbox" id="d-rec-top" checked><span><strong>Start the song from the beginning${solo ? '' : ' for everyone'}</strong></span></label>
        </div>
        <div class="dlg__actions">
          <button class="btn btn--quiet" value="cancel">Cancel</button>
          <button class="btn btn--primary" value="go" id="d-rec-go">Start recording</button>
        </div>
      </form>
    </dialog>

    <dialog id="d-done" aria-labelledby="d-done-h">
      <div class="dlg">
        <div style="display:grid;gap:8px"><span class="label" id="d-done-k">Recording finished</span><h2 id="d-done-h" style="font-size:28px">That’s a wrap. Keep your karaoke?</h2>
        <p class="muted" id="d-done-note"></p></div>
        <video id="d-done-video" controls playsinline></video>
        <p class="export" id="d-done-status" role="status"></p>
        <div class="dlg__actions">
          <button class="btn btn--quiet" type="button" id="d-done-discard">Close</button>
          <a class="btn btn--line" id="d-done-raw" download hidden>Original file</a>
          <a class="btn btn--primary" id="d-done-dl" download aria-disabled="true">Download MP4</a>
        </div>
      </div>
    </dialog>

    <dialog id="d-share" aria-labelledby="d-share-h">
      <form method="dialog" class="dlg">
        <div style="display:grid;gap:8px"><span class="label">Private room ready</span><h2 id="d-share-h" style="font-size:28px">Share this code with your friends</h2>
        <p class="muted">Only people who have it can join.</p></div>
        <div class="reveal__id" id="d-share-code"></div>
        <div class="dlg__actions">
          <button class="btn btn--quiet" value="close">Done</button>
          <button class="btn btn--tonal" type="button" id="d-share-link">Copy invite link</button>
          <button class="btn btn--primary" type="button" id="d-share-copy">Copy code</button>
        </div>
      </form>
    </dialog>`;

  const $ = (id) => document.getElementById(id);
  const els = {
    name: $('r-name'), kind: $('r-kind'), screen: $('r-screen'), empty: $('r-empty'), shield: $('r-shield'),
    play: $('r-play'), restart: $('r-restart'), mic: $('r-mic'), cam: $('r-cam'), rec: $('r-rec'), title: $('r-title'),
    bar: $('r-bar'), fill: $('r-fill'), cur: $('r-cur'), dur: $('r-dur'), tiles: $('r-tiles'), count: $('r-count'),
    audio: $('r-audio'), reacts: $('r-reacts'), recbadge: $('r-recbadge'), recnames: $('r-recnames'), micwarn: $('r-micwarn'),
    chat: $('r-chat'), chatform: $('r-chatform'), chatinput: $('r-chatinput'),
    queue: $('r-queue'), qcount: $('r-qcount'), skip: $('r-skip'), by: $('r-by'),
  };

  // ---------- Up next ----------
  S.queue = [];
  function renderQueue() {
    const rows = [];
    if (S.media.videoId) {
      rows.push(`<li class="qitem qitem--now"><img class="qitem__thumb" src="${thumb(S.media.videoId)}" alt="" loading="lazy">
        <div style="min-width:0"><div class="qitem__title">${esc(S.media.title || 'Loading title…')}</div><div class="qitem__by">Now playing${S.media.by ? ` · added by ${esc(S.media.by)}` : ''}</div></div><span></span></li>`);
    }
    for (const q of S.queue) {
      rows.push(`<li class="qitem"><img class="qitem__thumb" src="${thumb(q.videoId)}" alt="" loading="lazy">
        <div style="min-width:0"><div class="qitem__title">${esc(q.title || 'YouTube video')}</div><div class="qitem__by">Added by ${esc(q.by)}</div></div>
        <button class="qitem__x" type="button" data-remove="${esc(q.id)}" aria-label="Remove ${esc(q.title || 'this song')} from Up next">${I.x}</button></li>`);
    }
    if (!S.queue.length) rows.push(`<li class="queue__empty">${S.media.videoId ? 'Nothing lined up. Add the next song below.' : 'Paste a lyrics or karaoke video from YouTube to start.'}</li>`);
    els.queue.innerHTML = rows.join('');
    els.qcount.textContent = S.queue.length ? `${S.queue.length} waiting` : '';
    els.skip.disabled = !S.queue.length;
  }
  els.queue.addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    if (solo) { S.queue = S.queue.filter((q) => q.id !== b.dataset.remove); renderQueue(); }
    else S.socket?.emit('queue:remove', { id: b.dataset.remove });
  });
  function playNextLocal() {
    const n = S.queue.shift();
    if (!n) return false;
    applyMedia({ videoId: n.videoId, title: n.title, playing: true, position: 0, at: Date.now(), by: n.by });
    renderQueue();
    return true;
  }

  // ---------- video tiles (everyone in the room) ----------
  const tiles = new Map(); // key ('me' | socketId) -> { el, video, avatar, name, mic, state }
  function tileFor(key) {
    let t = tiles.get(key);
    if (t) return t;
    const el = document.createElement('div');
    el.className = 'tile' + (key === 'me' ? ' tile--me' : '');
    el.innerHTML = `
      <video class="tile__video" autoplay playsinline muted hidden></video>
      <div class="tile__avatar"><span class="avatar"></span></div>
      <span class="tile__state"></span>
      <div class="tile__foot"><span class="tile__name"></span><span class="tile__mic" hidden>${I.micOff}</span></div>`;
    t = {
      el, video: el.querySelector('video'), avatar: el.querySelector('.avatar'), name: el.querySelector('.tile__name'),
      mic: el.querySelector('.tile__mic'), state: el.querySelector('.tile__state'),
    };
    tiles.set(key, t);
    els.tiles.appendChild(el);
    return t;
  }
  function setTileVideo(t, stream) {
    if (stream) {
      if (t.video.srcObject !== stream) { t.video.srcObject = stream; t.video.play().catch(() => {}); }
      t.video.hidden = false;
    } else {
      t.video.hidden = true;
      if (t.video.srcObject) t.video.srcObject = null;
    }
  }
  function renderTiles() {
    const keep = new Set(['me']);
    const mine = tileFor('me');
    mine.avatar.textContent = initials(me.username);
    mine.avatar.style.background = colorFor(me.id);
    mine.name.textContent = `${me.username} (you)`;
    mine.mic.hidden = !S.micMuted && !!S.localStream;
    mine.state.textContent = S.localStream ? '' : 'No mic';
    mine.state.hidden = !!S.localStream;
    setTileVideo(mine, S.camStream);

    for (const [sid, p] of S.peers) {
      keep.add(sid);
      const t = tileFor(sid);
      t.avatar.textContent = initials(p.username);
      t.avatar.style.background = colorFor(p.userId);
      t.name.textContent = p.username;
      t.mic.hidden = p.mic !== false;
      const st = p.state;
      t.state.hidden = st === 'connected';
      t.state.textContent = st === 'failed' || st === 'disconnected' ? 'No audio' : 'Connecting';
      t.state.classList.toggle('tile__state--warn', st === 'failed' || st === 'disconnected');
      setTileVideo(t, p.cam && p.videoStream ? p.videoStream : null);
    }
    for (const [key, t] of tiles) {
      if (!keep.has(key)) { t.video.srcObject = null; t.el.remove(); tiles.delete(key); }
    }
    els.tiles.dataset.n = String(tiles.size);
    if (!solo && S.room) els.count.textContent = `${S.peers.size + 1} of ${S.room.capacity} here`;
  }

  function meterLoop() {
    const buf = new Uint8Array(256);
    const level = (an) => {
      if (!an) return 0;
      an.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      return Math.min(1, Math.sqrt(sum / buf.length) * 5);
    };
    const tick = () => {
      if (S.disposed) return;
      const set = (key, an) => {
        const v = level(an);
        S.levels.set(key, v);
        const t = tiles.get(key);
        if (t) t.el.style.setProperty('--lvl', v.toFixed(2));
      };
      set('me', S.micMuted ? null : S.localAnalyser);
      for (const [sid, p] of S.peers) set(sid, p.mic === false ? null : p.analyser);
      S.raf = requestAnimationFrame(tick);
    };
    tick();
  }

  // ---------- mic & camera ----------
  async function initMic() {
    try {
      S.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // On touch screens only the end of a tap counts as permission to play sound.
      for (const ev of UNLOCK_EVENTS) document.addEventListener(ev, resumeCtx, { capture: true });
    } catch {}
    try {
      // Echo cancellation on for the live call, so friends don't hear the track twice.
      S.localStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      });
      S.localStream.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (!S.disposed) toast('Your microphone disconnected (unplugged, or taken by another app). Reconnect it and reload the page.', 8000);
      });
      if (S.ctx) {
        S.localAnalyser = S.ctx.createAnalyser();
        S.localAnalyser.fftSize = 512;
        S.ctx.createMediaStreamSource(S.localStream).connect(S.localAnalyser);
      }
    } catch {
      els.micwarn.hidden = false;
      els.micwarn.textContent = 'Microphone is blocked. Allow it from the icon in the address bar, then reload so others can hear you.';
      els.mic.disabled = true;
    }
  }
  // iPhones/iPads (and strict autoplay settings elsewhere) keep audio silent until the person
  // taps the page. On every tap: wake the audio engine and start any friend's voice still paused.
  function resumeCtx() {
    if (S.ctx && S.ctx.state === 'suspended') S.ctx.resume().catch(() => {});
    els.audio?.querySelectorAll('audio').forEach((a) => { if (a.paused && a.srcObject) a.play().catch(() => {}); });
  }

  function setMicMuted(muted) {
    S.micMuted = muted;
    S.localStream?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    if (S.rec?.micGain) S.rec.micGain.gain.value = muted ? 0 : S.rec.micLevel;
    els.mic.innerHTML = muted ? I.micOff : I.mic;
    els.mic.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
    els.mic.setAttribute('aria-pressed', String(muted));
    els.mic.classList.toggle('is-off', muted);
    S.socket?.emit('state', { mic: !muted });
    renderTiles();
  }
  els.mic.addEventListener('click', () => { if (S.localStream) setMicMuted(!S.micMuted); });

  async function setCamera(on) {
    if (on && !S.camTrack) {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 480 }, height: { ideal: 360 }, frameRate: { ideal: 20, max: 24 }, facingMode: 'user' },
        });
        S.camTrack = s.getVideoTracks()[0];
        S.camStream = new MediaStream([S.camTrack]);
        // On Windows another app or browser tab can take the webcam over, which ends ours.
        S.camTrack.addEventListener('ended', () => {
          if (S.disposed) return;
          toast('Your camera stopped. Another app or tab may be using it. Close that, then turn your camera back on.', 7000);
          setCamera(false);
        });
      } catch {
        toast('Camera is blocked or busy. Allow it from the icon in the address bar.');
        return;
      }
    } else if (!on && S.camTrack) {
      S.camTrack.stop();
      S.camTrack = null;
      S.camStream = null;
    } else return;
    await Promise.all([...S.peers.values()].map((p) => p.videoSender?.replaceTrack(S.camTrack).catch(() => {})));
    tuneAllSenders();
    if (els.cam) {
      els.cam.innerHTML = S.camTrack ? I.cam : I.camOff;
      els.cam.setAttribute('aria-label', S.camTrack ? 'Turn camera off' : 'Turn camera on');
      els.cam.setAttribute('aria-pressed', String(!!S.camTrack));
      els.cam.classList.toggle('is-on', !!S.camTrack);
    }
    S.socket?.emit('state', { cam: !!S.camTrack });
    renderTiles();
  }
  els.cam?.addEventListener('click', () => setCamera(!S.camTrack));

  // ---------- WebRTC ----------
  // Every connection carries one audio track (your voice) and one video slot.
  // The video slot is always negotiated, so turning the camera on/off is just replaceTrack().
  function createPeer(sid, info, initiator) {
    closePeer(sid);
    const pc = new RTCPeerConnection(ICE);
    const peer = {
      pc, initiator, username: info.username, userId: info.userId, cam: !!info.cam, mic: info.mic !== false,
      audio: null, stream: null, videoStream: null, analyser: null, pending: [], state: 'new', videoSender: null,
    };
    S.peers.set(sid, peer);
    if (S.localStream) S.localStream.getAudioTracks().forEach((t) => pc.addTrack(t, S.localStream));
    else pc.addTransceiver('audio', { direction: 'recvonly' });
    if (initiator) {
      const tr = pc.addTransceiver('video', { direction: 'sendrecv' });
      peer.videoSender = tr.sender;
      if (S.camTrack) tr.sender.replaceTrack(S.camTrack).catch(() => {});
    }

    pc.onicecandidate = (e) => { if (e.candidate) S.socket.emit('signal', { to: sid, data: { candidate: e.candidate } }); };
    pc.ontrack = (e) => {
      if (e.track.kind === 'video') {
        peer.videoStream = new MediaStream([e.track]);
        renderTiles();
        return;
      }
      const stream = e.streams[0] || new MediaStream([e.track]);
      peer.stream = stream;
      if (!peer.audio) {
        peer.audio = document.createElement('audio');
        peer.audio.autoplay = true;
        peer.audio.playsInline = true;
        els.audio.appendChild(peer.audio);
      }
      peer.audio.srcObject = stream;
      peer.audio.play().catch(() => {
        if (!S.tapHint) { S.tapHint = true; toast('Tap anywhere on the page to hear your friends.', 7000); }
      });
      if (S.ctx) {
        try {
          peer.analyser = S.ctx.createAnalyser();
          peer.analyser.fftSize = 512;
          S.ctx.createMediaStreamSource(stream).connect(peer.analyser);
        } catch {}
      }
    };
    pc.onconnectionstatechange = () => {
      peer.state = pc.connectionState;
      renderTiles();
      if (pc.connectionState === 'connected') tuneAllSenders();
      // The side that made the offer retries once with fresh candidates (TURN gets another chance).
      if (pc.connectionState === 'failed' && peer.initiator && !peer.restarted) {
        peer.restarted = true;
        pc.createOffer({ iceRestart: true })
          .then((o) => pc.setLocalDescription(o))
          .then(() => S.socket.emit('signal', { to: sid, data: { sdp: pc.localDescription } }))
          .catch(() => {});
      }
    };
    renderTiles();
    return peer;
  }

  // Everyone sends their camera to everyone else, so upload and CPU grow with the room.
  // Step video quality down as the room fills up; voices always get priority.
  const VIDEO_STEPS = [
    { upTo: 2, maxBitrate: 600_000, scale: 1, fps: 24 },
    { upTo: 4, maxBitrate: 350_000, scale: 1.5, fps: 20 },
    { upTo: 6, maxBitrate: 200_000, scale: 2, fps: 15 },
    { upTo: Infinity, maxBitrate: 110_000, scale: 3, fps: 12 },
  ];
  async function tuneSender(sender, kind) {
    try {
      const p = sender.getParameters();
      if (!p.encodings || !p.encodings.length) return; // not negotiated yet; retried on connect
      const e = p.encodings[0];
      if (kind === 'audio') { e.priority = 'high'; e.networkPriority = 'high'; e.maxBitrate = 64_000; }
      else {
        // No frame-rate cap: in Microsoft Edge, capping it (on the sender or on the camera)
        // stops video from being sent. The bitrate cap makes the encoder drop frames as needed.
        const step = currentVideoStep();
        Object.assign(e, { maxBitrate: step.maxBitrate, scaleResolutionDownBy: step.scale, priority: 'low', networkPriority: 'low' });
      }
      await sender.setParameters(p);
    } catch { /* older browsers: keep defaults */ }
  }
  const currentVideoStep = () => VIDEO_STEPS.find((s) => S.peers.size <= s.upTo);
  function tuneAllSenders() {
    // Big rooms: everyone sends video to everyone, which is a lot for phones and home internet.
    if (S.peers.size >= 6 && S.camTrack && !S.bigRoomTip) {
      S.bigRoomTip = true;
      toast('Big room! If video gets choppy, turning cameras off keeps everyone’s singing smooth.', 7000);
    }
    for (const p of S.peers.values()) {
      if (p.pc.connectionState !== 'connected') continue;
      for (const s of p.pc.getSenders()) if (s.track) tuneSender(s, s.track.kind);
    }
  }

  function closePeer(sid) {
    const p = S.peers.get(sid);
    if (!p) return;
    try { p.pc.close(); } catch {}
    if (p.audio) { p.audio.srcObject = null; p.audio.remove(); }
    S.peers.delete(sid);
  }

  async function callPeer(info) {
    const peer = createPeer(info.socketId, info, true);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    S.socket.emit('signal', { to: info.socketId, data: { sdp: peer.pc.localDescription } });
  }

  async function onSignal({ from, data }) {
    let peer = S.peers.get(from);
    try {
      if (data.sdp) {
        if (data.sdp.type === 'offer') {
          // Reuse the connection for an ICE-restart offer; otherwise start fresh.
          if (!peer || peer.initiator || peer.pc.signalingState === 'closed') {
            const info = S.pendingInfo.get(from) || { username: 'Guest', userId: from };
            peer = createPeer(from, info, false);
          }
          await peer.pc.setRemoteDescription(data.sdp);
          // Answer the offer's video slot both ways so our camera can use it later.
          if (!peer.videoSender) {
            const tr = peer.pc.getTransceivers().find((t) => t.receiver.track?.kind === 'video');
            if (tr) {
              tr.direction = 'sendrecv';
              peer.videoSender = tr.sender;
              if (S.camTrack) await tr.sender.replaceTrack(S.camTrack).catch(() => {});
            }
          }
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          S.socket.emit('signal', { to: from, data: { sdp: peer.pc.localDescription } });
        } else if (peer) {
          await peer.pc.setRemoteDescription(data.sdp);
        }
        if (peer) { for (const c of peer.pending) await peer.pc.addIceCandidate(c).catch(() => {}); peer.pending = []; }
      } else if (data.candidate && peer) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pending.push(data.candidate);
      }
    } catch (err) { console.warn('signal error', err); }
  }

  // ---------- YouTube ----------
  async function ensurePlayer(videoId) {
    const YT = await loadYouTubeAPI();
    if (S.disposed) return;
    if (S.player) {
      if (S.loadedId !== videoId) { S.loadedId = videoId; S.ytError = null; S.player.cueVideoById(videoId); }
      return;
    }
    S.loadedId = videoId;
    const slow = setTimeout(() => {
      if (!S.playerReady && !S.disposed) toast('YouTube is slow to load here. Check your connection, or open the app at http://localhost:3000.');
    }, 10_000);
    await new Promise((resolve) => {
      S.player = new YT.Player('r-player', {
        videoId,
        width: '100%', height: '100%',
        playerVars: { controls: 0, disablekb: 1, modestbranding: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0, origin: location.origin },
        events: {
          onReady: () => { S.playerReady = true; clearTimeout(slow); resolve(); },
          onStateChange: onPlayerState,
          onError: (e) => {
            // 101/150: uploader blocks embedding; 100: removed/private; 2/5: bad ID or player error; 153: site address not accepted.
            S.ytError = e.data;
            S.blocked = false;
            const msg = e.data === 101 || e.data === 150
              ? 'The uploader doesn’t allow this video on other sites. Paste a different upload of the song.'
              : e.data === 100
                ? 'This video was removed or is private. Try another link.'
                : 'YouTube couldn’t play this video here. Try another link.';
            toast(msg, 7000);
            els.title.textContent = 'Can’t play: ' + (S.media.title || 'this video');
          },
        },
      });
    });
  }

  function setTitle(t) {
    if (!t || t === S.media.title) return;
    S.media.title = t;
    els.title.textContent = t;
    renderQueue();
    if (!solo) S.socket?.emit('media:title', { videoId: S.loadedId, title: t });
  }

  function onPlayerState(e) {
    const YT = window.YT;
    const playing = e.data === YT.PlayerState.PLAYING;
    els.play.innerHTML = playing ? I.pause : I.play;
    els.play.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    if (playing) S.blocked = false;
    if (playing && S.hold) S.player.pauseVideo(); // stay quiet while the save dialog is up
    if (playing || e.data === YT.PlayerState.CUED) setTitle(S.player.getVideoData?.().title);
    if (e.data === YT.PlayerState.ENDED) onSongEnded();
  }

  async function applyMedia(m) {
    S.media = { ...S.media, ...m };
    if (!m.videoId) return;
    els.empty.hidden = true;
    els.shield.hidden = false;
    els.play.disabled = false;
    els.restart.disabled = false;
    els.rec.disabled = false;
    els.title.textContent = m.title || S.media.title || 'Loading…';
    els.by.textContent = S.media.by ? `Added by ${S.media.by}` : 'Now playing';
    renderQueue();
    await ensurePlayer(m.videoId);
    if (S.disposed || !S.player) return;
    const pos = expectedPos(S.media);
    if (S.media.playing && !S.hold) {
      S.player.seekTo(pos, true);
      S.player.playVideo();
      setTimeout(() => {
        if (S.disposed || !S.player || !S.media.playing || S.hold) return;
        const st = S.player.getPlayerState();
        if (S.ytError) return; // YouTube refused the video: tapping won't help, the error message says why
        if (st !== window.YT.PlayerState.PLAYING && st !== window.YT.PlayerState.BUFFERING) {
          S.blocked = true;
          toast('Tap the video to start playback in sync.');
        }
      }, 1800);
    } else {
      // seekTo on a cued video starts playback, so only seek when needed and pause after.
      const st = S.player.getPlayerState();
      const fresh = st === window.YT.PlayerState.CUED || st === window.YT.PlayerState.UNSTARTED;
      if (!(fresh && pos < 0.5)) S.player.seekTo(pos, true);
      S.player.pauseVideo();
      if (!fresh || pos >= 0.5) setTimeout(() => { if ((!S.media.playing || S.hold) && S.player) S.player.pauseVideo(); }, 400);
    }
  }

  function send(action, position) {
    if (!S.media.videoId) return;
    if (solo) {
      const m = { ...S.media, at: Date.now() };
      if (action === 'play') Object.assign(m, { playing: true, position });
      if (action === 'pause' || action === 'ended') Object.assign(m, { playing: false, position });
      if (action === 'seek') Object.assign(m, { position });
      applyMedia(m);
    } else {
      S.socket.emit('media:control', { action, position });
    }
  }

  const curTime = () => (S.player && S.playerReady ? S.player.getCurrentTime() || 0 : 0);
  const isPlaying = () => S.player && S.playerReady && S.player.getPlayerState() === window.YT.PlayerState.PLAYING;

  els.play.addEventListener('click', () => send(isPlaying() || (S.media.playing && !S.blocked) ? 'pause' : 'play', curTime()));
  els.restart.addEventListener('click', () => send(S.media.playing ? 'play' : 'seek', 0));
  els.shield.addEventListener('click', () => {
    resumeCtx();
    if (S.blocked) { S.blocked = false; applyMedia(S.media); return; }
    els.play.click();
  });

  const seekFromEvent = (clientX) => {
    const dur = S.player?.getDuration?.() || 0;
    if (!dur) return;
    const r = els.bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    send(S.media.playing ? 'play' : 'seek', ratio * dur);
  };
  els.bar.addEventListener('click', (e) => seekFromEvent(e.clientX));
  els.bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const t = curTime() + (e.key === 'ArrowRight' ? 5 : -5);
    send(S.media.playing ? 'play' : 'seek', Math.max(0, t));
  });

  S.timers.push(setInterval(() => {
    if (!S.player || !S.playerReady) return;
    const dur = S.player.getDuration() || 0;
    const cur = curTime();
    if (!S.media.title) setTitle(S.player.getVideoData?.().title);
    els.cur.textContent = fmt(cur);
    els.dur.textContent = fmt(dur);
    els.fill.style.transform = `scaleX(${dur ? Math.min(1, cur / dur) : 0})`;
    els.bar.setAttribute('aria-valuemax', String(Math.round(dur)));
    els.bar.setAttribute('aria-valuenow', String(Math.round(cur)));
  }, 250));

  // Keep everyone within ~0.8s of the room clock.
  if (!solo) {
    S.timers.push(setInterval(() => {
      if (!S.media.playing || S.hold || !isPlaying() || S.rec?.starting) return;
      const drift = curTime() - expectedPos();
      if (Math.abs(drift) > 0.8) S.player.seekTo(expectedPos(), true);
    }, 4000));
  }

  $('r-load').addEventListener('submit', async (e) => {
    e.preventDefault();
    const mode = e.submitter?.value === 'now' ? 'now' : 'queue';
    const input = $('r-url');
    const id = parseYouTube(input.value);
    if (!id) { toast('That doesn’t look like a YouTube link.'); input.focus(); return; }
    // Title lookup only. YouTube's lookup refuses some videos that still play fine in the
    // player, so it must never block a song; the player itself reports videos it can't play.
    const info = await videoInfo(id);
    input.value = '';
    const item = { videoId: id, title: info.title };
    if (mode === 'now' || !S.media.videoId) {
      if (S.rec) stopRecording('switched');
      if (solo) applyMedia({ ...item, playing: false, position: 0, at: Date.now(), by: me.username });
      else S.socket.emit('media:load', item);
      return;
    }
    if (solo) { S.queue.push({ ...item, id: Math.random().toString(36).slice(2, 10), by: me.username }); renderQueue(); }
    else S.socket.emit('queue:add', item);
    toast(`Added to Up next${info.title ? `: ${info.title}` : ''}`);
  });
  els.skip.addEventListener('click', () => {
    if (S.rec) stopRecording('switched');
    if (solo) playNextLocal(); else S.socket.emit('queue:next');
  });

  // ---------- song end ----------
  let endedAt = 0;
  function onSongEnded() {
    if (Date.now() - endedAt < 3000) return;
    endedAt = Date.now();
    const hasNext = S.queue.length > 0;
    if (S.rec) stopRecording('ended');
    // The server moves the whole room to the next song; solo does it locally.
    if (!solo && S.media.playing) S.socket.emit('media:control', { action: 'ended', position: curTime(), videoId: S.media.videoId });
    if (solo) { S.media.playing = false; if (!S.rec && hasNext) { playNextLocal(); return; } }
    if (!S.rec && !hasNext) toast('Song finished. Add another to Up next or press play to go again.');
  }

  // ---------- recording ----------
  const dRec = $('d-rec');
  const dDone = $('d-done');
  els.rec.addEventListener('click', () => {
    if (S.rec) { stopRecording('manual'); return; }
    if (!S.media.videoId) { toast('Load a song first.'); return; }
    dRec.showModal();
  });
  dRec.addEventListener('close', () => {
    if (dRec.returnValue === 'go') startRecording({ fromTop: $('d-rec-top').checked, withMusic: CAN_RECORD_MUSIC && $('d-rec-music').checked });
  });
  $('d-rec-music').addEventListener('change', (e) => { $('d-rec-go').textContent = e.target.checked ? 'Choose tab and record' : 'Start recording'; });
  $('d-rec-go').textContent = CAN_RECORD_MUSIC ? 'Choose tab and record' : 'Start recording';

  // ---------- recording picture: the voice & video tiles, drawn onto a canvas ----------
  function participants() {
    const list = [{
      // Preview is mirrored like a selfie; the recording shows you as others see you.
      key: 'me', name: me.username, userId: me.id, mirror: false, muted: S.micMuted || !S.localStream,
      video: S.camStream ? tiles.get('me')?.video : null,
    }];
    for (const [sid, p] of S.peers) {
      list.push({
        key: sid, name: p.username, userId: p.userId, mirror: false, muted: p.mic === false,
        video: p.cam && p.videoStream ? tiles.get(sid)?.video : null,
      });
    }
    return list;
  }

  function rrect(g, x, y, w, h, r) {
    g.beginPath();
    if (g.roundRect) g.roundRect(x, y, w, h, r);
    else { g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  }
  function fitText(g, text, max) {
    if (g.measureText(text).width <= max) return text;
    let t = text;
    while (t.length > 1 && g.measureText(t + '…').width > max) t = t.slice(0, -1);
    return t + '…';
  }

  function drawTile(g, p, x, y, w, h) {
    const lvl = p.muted ? 0 : (S.levels.get(p.key) || 0);
    g.save();
    rrect(g, x, y, w, h, 16);
    g.clip();
    g.fillStyle = '#080A11';
    g.fillRect(x, y, w, h);
    const v = p.video;
    if (v && v.readyState >= 2 && v.videoWidth) {
      // cover-fit the camera into the tile
      const s = Math.max(w / v.videoWidth, h / v.videoHeight);
      const dw = v.videoWidth * s, dh = v.videoHeight * s;
      if (p.mirror) { g.translate(x + w, y); g.scale(-1, 1); g.drawImage(v, (w - dw) / 2, (h - dh) / 2, dw, dh); }
      else g.drawImage(v, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
    } else {
      const glow = g.createRadialGradient(x + w / 2, y, 0, x + w / 2, y, h);
      glow.addColorStop(0, 'rgba(227,168,87,0.16)');
      glow.addColorStop(1, 'rgba(227,168,87,0)');
      g.fillStyle = glow;
      g.fillRect(x, y, w, h);
      const r = Math.min(w, h) * 0.17;
      g.fillStyle = colorFor(p.userId);
      g.beginPath(); g.arc(x + w / 2, y + h / 2, r, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#fff';
      g.font = `600 ${Math.round(r * 0.75)}px "Instrument Sans", system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(initials(p.name), x + w / 2, y + h / 2 + 1);
    }
    g.restore();

    // name pill
    g.save();
    const fs = Math.max(13, Math.round(h * 0.055));
    g.font = `500 ${fs}px "Instrument Sans", system-ui, sans-serif`;
    g.textAlign = 'left'; g.textBaseline = 'middle';
    const label = fitText(g, p.name, w - 70);
    const pw = g.measureText(label).width + fs * 1.2;
    const ph = fs * 1.8;
    g.fillStyle = 'rgba(8,10,17,0.8)';
    rrect(g, x + 10, y + h - ph - 10, pw, ph, ph / 2); g.fill();
    g.fillStyle = '#F2E8D5';
    g.fillText(label, x + 10 + fs * 0.6, y + h - ph / 2 - 10);
    if (p.muted) {
      const cx = x + w - 10 - ph / 2, cy = y + h - ph / 2 - 10;
      g.fillStyle = 'rgba(8,10,17,0.8)'; g.beginPath(); g.arc(cx, cy, ph / 2, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#F08A7A'; g.lineWidth = 2; g.beginPath(); g.moveTo(cx - ph * 0.2, cy - ph * 0.2); g.lineTo(cx + ph * 0.2, cy + ph * 0.2); g.stroke();
    }
    // singing ring
    g.strokeStyle = lvl > 0.05 ? `rgba(227,168,87,${Math.min(1, 0.25 + lvl)})` : 'rgba(242,232,213,0.09)';
    g.lineWidth = lvl > 0.05 ? 2 + lvl * 5 : 1;
    rrect(g, x, y, w, h, 16); g.stroke();
    g.restore();
  }

  function startCompositor(rec) {
    const W = 1280, H = 720;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const draw = () => {
      g.fillStyle = '#0D111B';
      g.fillRect(0, 0, W, H);
      const lamp = g.createRadialGradient(W * 0.15, -60, 0, W * 0.15, -60, 760);
      lamp.addColorStop(0, 'rgba(227,168,87,0.18)');
      lamp.addColorStop(1, 'rgba(227,168,87,0)');
      g.fillStyle = lamp;
      g.fillRect(0, 0, W, H);

      const people = participants();
      const n = people.length;
      const pad = 36, gap = 16, top = 32, bottom = 84;
      const areaW = W - pad * 2, areaH = H - top - bottom;
      let best = { w: 0, cols: 1, rows: 1 };
      for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols);
        const cw = (areaW - gap * (cols - 1)) / cols;
        const ch = (areaH - gap * (rows - 1)) / rows;
        const w = Math.min(cw, (ch * 4) / 3);
        if (w > best.w) best = { w, cols, rows };
      }
      const tw = best.w, th = (tw * 3) / 4;
      const y0 = top + (areaH - (best.rows * th + gap * (best.rows - 1))) / 2;
      people.forEach((p, i) => {
        const r = Math.floor(i / best.cols), c = i % best.cols;
        const inRow = Math.min(best.cols, n - r * best.cols);
        const x0 = pad + (areaW - (inRow * tw + gap * (inRow - 1))) / 2;
        drawTile(g, p, x0 + c * (tw + gap), y0 + r * (th + gap), tw, th);
      });

      // footer: brand, song, time
      const fy = H - bottom / 2;
      g.textBaseline = 'middle';
      g.textAlign = 'left';
      g.fillStyle = '#E3A857';
      g.beginPath(); g.arc(pad + 10, fy, 10, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#080A11';
      g.beginPath(); g.arc(pad + 10, fy, 2.5, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#F2E8D5';
      g.font = 'italic 500 28px Fraunces, Georgia, serif';
      g.fillText('Duet', pad + 30, fy);
      g.fillStyle = '#A69D8E';
      g.font = '500 19px "Instrument Sans", system-ui, sans-serif';
      g.textAlign = 'right';
      const t = `${fmt(curTime())} / ${fmt(S.player?.getDuration?.() || 0)}`;
      g.fillText(t, W - pad, fy);
      const tw2 = g.measureText(t).width;
      g.textAlign = 'left';
      g.fillStyle = '#D9CDB8';
      g.font = 'italic 400 21px Fraunces, Georgia, serif';
      g.fillText(fitText(g, S.media.title || '', W - pad * 2 - 140 - tw2 - 24), pad + 120, fy);
    };
    draw();
    rec.drawTimer = setInterval(draw, 1000 / 30);
    return cv.captureStream(30).getVideoTracks()[0];
  }

  function pickMime(withVideo) {
    const list = withVideo
      // H.264 + AAC first: the server can then just repackage it (instant) instead of re-encoding.
      ? ['video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
      : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
    return list.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
  }

  // A separate, unprocessed mic feed for the recording. The call's mic has echo
  // cancellation, which treats your singing over loud music as echo and squashes it.
  async function openRecordingMic() {
    if (!S.localStream) return null;
    const deviceId = S.localStream.getAudioTracks()[0]?.getSettings?.().deviceId;
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1,
        },
      });
    } catch { return null; }
  }

  async function startRecording({ fromTop, withMusic }) {
    resumeCtx();
    if (!S.ctx) { toast('Recording isn’t supported in this browser.'); return; }
    // The tab share is only used for its audio (the backing music). The picture comes from the tiles.
    let display = null;
    if (withMusic && !navigator.mediaDevices?.getDisplayMedia) toast('This browser can’t capture the music, so it’ll be voices only.');
    if (withMusic && navigator.mediaDevices?.getDisplayMedia) {
      try {
        display = await navigator.mediaDevices.getDisplayMedia({
          video: { displaySurface: 'browser', frameRate: 30 },
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, suppressLocalAudioPlayback: false },
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
          surfaceSwitching: 'exclude',
          systemAudio: 'include',
        });
      } catch (err) {
        if (err && err.name === 'NotAllowedError') { toast('Recording cancelled.'); return; }
        display = null;
      }
    }
    // Browsers only start audio after a real click; never wait on that forever.
    if (S.ctx.state === 'suspended') {
      await Promise.race([S.ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    }
    if (S.ctx.state !== 'running') {
      display?.getTracks().forEach((t) => t.stop());
      toast('Your browser hasn’t switched sound on yet. Click anywhere on the page, then press Record song again.', 6000);
      return;
    }

    const ctx = S.ctx;
    const dest = ctx.createMediaStreamDestination();
    const nodes = [];
    // Silent source keeps the audio track ticking. Without any input, Chrome's
    // MediaRecorder waits for audio and writes nothing at all.
    const keepAlive = ctx.createConstantSource();
    keepAlive.offset.value = 0;
    keepAlive.connect(dest);
    keepAlive.start();
    nodes.push(keepAlive);
    const hasTabAudio = !!display && display.getAudioTracks().length > 0;
    if (hasTabAudio) {
      // Tab audio already carries the YouTube music and everyone else's voices.
      const n = ctx.createMediaStreamSource(new MediaStream(display.getAudioTracks()));
      const g = ctx.createGain(); g.gain.value = 0.85;
      n.connect(g).connect(dest); nodes.push(n, g);
    } else {
      for (const p of S.peers.values()) {
        if (p.stream) { const n = ctx.createMediaStreamSource(p.stream); n.connect(dest); nodes.push(n); }
      }
    }

    // Your voice: clean mic -> low-cut -> gentle compressor -> level -> mix.
    const recMic = await openRecordingMic();
    const micSource = recMic || S.localStream;
    let micGain = null;
    let micAnalyser = null;
    const micLevel = 1.6;
    if (micSource) {
      const src = ctx.createMediaStreamSource(micSource);
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -24; comp.knee.value = 12; comp.ratio.value = 3; comp.attack.value = 0.005; comp.release.value = 0.2;
      micGain = ctx.createGain(); micGain.gain.value = S.micMuted ? 0 : micLevel;
      micAnalyser = ctx.createAnalyser(); micAnalyser.fftSize = 1024;
      src.connect(hp).connect(comp).connect(micGain).connect(dest);
      src.connect(micAnalyser);
      nodes.push(src, hp, comp, micGain, micAnalyser);
    }

    const rec = {
      display, recMic, nodes, hasTabAudio, withVideo: true, startedAt: 0,
      reason: null, title: S.media.title, micGain, micLevel, peakVoice: 0, starting: false,
    };
    const videoTrack = startCompositor(rec);
    const out = new MediaStream([videoTrack, ...dest.stream.getAudioTracks()]);
    const mimeType = pickMime(true);
    let recorder;
    try { recorder = new MediaRecorder(out, mimeType ? { mimeType, videoBitsPerSecond: 2_500_000, audioBitsPerSecond: 192_000 } : undefined); }
    catch {
      toast('Recording isn’t supported in this browser.');
      clearInterval(rec.drawTimer);
      videoTrack.stop();
      display?.getTracks().forEach((t) => t.stop());
      recMic?.getTracks().forEach((t) => t.stop());
      return;
    }

    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    Object.assign(rec, { recorder, chunks, canvasTrack: videoTrack, startedAt: Date.now() });
    S.rec = rec;
    recorder.onstop = () => finishRecording(rec);
    // "Stop sharing" in Chrome's bar ends the tab share: stop the take too.
    display?.getTracks().forEach((t) => t.addEventListener('ended', () => S.rec === rec && stopRecording('manual')));

    // Watch the voice level; warn early if the recording can't hear you.
    if (micAnalyser) {
      const buf = new Float32Array(micAnalyser.fftSize);
      rec.voiceTimer = setInterval(() => {
        micAnalyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        rec.peakVoice = Math.max(rec.peakVoice, Math.sqrt(sum / buf.length));
        if (!rec.warned && Date.now() - rec.startedAt > 15_000 && rec.peakVoice < 0.01 && !S.micMuted) {
          rec.warned = true;
          toast('The recording can’t hear your mic. Check Chrome is using the right microphone (icon in the address bar).');
        }
      }, 400);
    }

    if (fromTop) {
      rec.starting = true;
      send('play', 0);
      await new Promise((r) => setTimeout(r, solo ? 150 : 400));
      rec.starting = false;
    } else if (!S.media.playing) {
      send('play', curTime());
    }
    recorder.start(1000);

    els.rec.setAttribute('aria-pressed', 'true');
    els.rec.innerHTML = `${I.stop}<span>Stop recording</span>`;
    if (!solo) S.socket.emit('rec', { on: true });
    else setRecorders([me.username]);
    if (!micSource) toast('No microphone, so your voice won’t be in the recording.');
    else if (S.micMuted) toast('Your mic is muted. Unmute it to be in the recording.');
    else if (withMusic && !hasTabAudio) toast('Tab audio wasn’t shared, so the music won’t be in the file. Voices are.');
    else if (!S.camTrack) toast('Recording. Turn your camera on to be seen in the video.');
    else toast('Recording. Sing your heart out.');
  }

  function stopRecording(reason) {
    if (!S.rec) return;
    S.rec.reason = reason;
    try { if (S.rec.recorder.state !== 'inactive') S.rec.recorder.stop(); else finishRecording(S.rec); } catch { finishRecording(S.rec); }
  }

  let exportAbort = null;
  const objectUrls = [];
  function finishRecording(rec) {
    if (!rec || rec.done) return;
    rec.done = true;
    clearInterval(rec.voiceTimer);
    clearInterval(rec.drawTimer);
    rec.canvasTrack?.stop();
    rec.display?.getTracks().forEach((t) => t.stop());
    rec.recMic?.getTracks().forEach((t) => t.stop());
    rec.nodes.forEach((n) => { try { n.stop?.(); } catch {} try { n.disconnect(); } catch {} });
    if (S.rec === rec) S.rec = null;
    els.rec.setAttribute('aria-pressed', 'false');
    els.rec.innerHTML = `${I.rec}<span>Record song</span>`;
    if (!solo) S.socket?.emit('rec', { on: false }); else setRecorders([]);
    if (S.disposed) return;
    if (!rec.chunks.length) { toast('Nothing was captured in that take. Try recording again.'); return; }

    // Pause the song while you decide what to do with the take.
    S.hold = true;
    if (solo) { if (S.media.playing) send('pause', curTime()); }
    else S.player?.pauseVideo();

    const type = rec.recorder.mimeType || (rec.withVideo ? 'video/webm' : 'audio/webm');
    const blob = new Blob(rec.chunks, { type });
    const rawUrl = URL.createObjectURL(blob);
    objectUrls.push(rawUrl);
    const slug = (rec.title || 'karaoke').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'karaoke';
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const base = `duet-${slug}-${stamp}`;
    const secs = Math.round((Date.now() - rec.startedAt) / 1000);
    const voiceNote = rec.peakVoice < 0.01 ? ' We couldn’t hear your mic during this take.' : '';

    $('d-done-k').textContent = rec.reason === 'ended' ? 'Song complete' : 'Recording stopped';
    $('d-done-h').textContent = rec.reason === 'ended' ? 'That’s a wrap. Download your karaoke?' : 'Keep this take?';
    $('d-done-note').textContent = `${fmt(secs)} recorded${rec.hasTabAudio ? ' with the music' + (solo ? '' : ' and everyone’s voices') : ', voices only'}. The song is paused while you decide.${voiceNote}`;
    const v = $('d-done-video');
    v.src = rawUrl;
    const raw = $('d-done-raw');
    raw.href = rawUrl;
    raw.download = `${base}-original.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    raw.hidden = false;

    // Convert to a normal, seekable MP4 on the server.
    const dl = $('d-done-dl');
    const status = $('d-done-status');
    const kind = rec.withVideo ? 'video' : 'audio';
    dl.removeAttribute('href');
    dl.setAttribute('aria-disabled', 'true');
    dl.textContent = 'Making your MP4…';
    status.className = 'export export--busy';
    status.textContent = `Converting so you can skip through it in any player. Usually takes ${secs > 120 ? 'under a minute' : 'a few seconds'}.`;
    exportAbort?.abort();
    exportAbort = new AbortController();
    const signal = exportAbort.signal;
    const vcodec = /avc1|h264/i.test(type) ? 'h264' : 'other';
    const acodec = /mp4a|aac/i.test(type) ? 'aac' : 'other';
    apiFetch(`/api/export?kind=${kind}&vcodec=${vcodec}&acodec=${acodec}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': blob.type || 'video/webm' },
      body: blob,
      signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Conversion failed.');
        return res.blob();
      })
      .then((mp4) => {
        if (signal.aborted) return;
        const url = URL.createObjectURL(mp4);
        objectUrls.push(url);
        dl.href = url;
        dl.download = `${base}.${kind === 'audio' ? 'm4a' : 'mp4'}`;
        dl.removeAttribute('aria-disabled');
        dl.textContent = kind === 'audio' ? 'Download M4A' : 'Download MP4';
        status.className = 'export export--ok';
        status.textContent = `Ready. ${(mp4.size / 1048576).toFixed(1)} MB, plays and skips in any player.`;
        const t = v.currentTime;
        const wasPlaying = !v.paused;
        v.src = url;
        v.addEventListener('loadedmetadata', () => { v.currentTime = t; if (wasPlaying) v.play().catch(() => {}); }, { once: true });
      })
      .catch((err) => {
        if (signal.aborted) return;
        dl.textContent = 'MP4 unavailable';
        status.className = 'export export--warn';
        status.textContent = `${err.message} You can still save the original file.`;
      });

    if (dDone.open) dDone.close();
    dDone.showModal();
  }
  $('d-done-discard').addEventListener('click', () => dDone.close());
  $('d-done-dl').addEventListener('click', (e) => {
    if (e.currentTarget.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    setTimeout(() => toast('Saved to your downloads.'), 300);
  });
  dDone.addEventListener('close', () => {
    $('d-done-video').pause();
    exportAbort?.abort();
    exportAbort = null;
    // Revoke later so an in-progress download isn't cut off.
    const urls = objectUrls.splice(0);
    setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 60_000);
    // Back to the room: rejoin the song where everyone else is.
    S.hold = false;
    if (!solo && S.media.playing) applyMedia(S.media);
  });

  function setRecorders(list) {
    S.recorders = list;
    els.recbadge.hidden = !list.length;
    els.recnames.textContent = !list.length ? '' : list.length === 1 ? `On air · ${list[0] === me.username ? 'you are' : list[0] + ' is'} recording` : `On air · ${list.length} people recording`;
  }

  // ---------- reactions ----------
  function floatReaction(emoji, username) {
    const el = document.createElement('div');
    el.className = 'float';
    el.style.left = `${12 + Math.random() * 76}%`; // centred on this point (translate -50%)
    el.innerHTML = `${emoji}<small>${esc(username)}</small>`;
    els.reacts.appendChild(el);
    setTimeout(() => el.remove(), 2900);
  }
  $('r-reactrow')?.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-e]');
    if (b) S.socket?.emit('react', { emoji: b.dataset.e });
  });

  // ---------- live chat ----------
  const seenMsgs = new Set();
  function addChat(item) {
    if (!els.chat) return;
    if (item.id) { if (seenMsgs.has(item.id)) return; seenMsgs.add(item.id); }
    const nearBottom = els.chat.scrollHeight - els.chat.scrollTop - els.chat.clientHeight < 60;
    const li = document.createElement('li');
    if (item.system) {
      li.className = 'msg msg--sys';
      li.textContent = item.text;
    } else {
      const mine = item.userId === me.id;
      li.className = 'msg' + (mine ? ' msg--me' : '');
      li.innerHTML = `<div class="msg__meta"><span class="msg__who">${esc(mine ? 'You' : item.username)}</span><time class="msg__time">${clock(item.at)}</time></div><p class="msg__text">${esc(item.text)}</p>`;
    }
    els.chat.appendChild(li);
    while (els.chat.children.length > 120) els.chat.firstElementChild.remove();
    if (nearBottom || item.userId === me.id) els.chat.scrollTop = els.chat.scrollHeight;
  }
  els.chatform?.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.chatinput.value.trim();
    if (!text || !S.socket?.connected) return;
    S.socket.emit('chat', { text });
    els.chatinput.value = '';
  });

  // ---------- room connection ----------
  function showError(msg) {
    main.querySelector('.room .wrap').innerHTML = `
      <div class="panel" style="max-width:560px;margin:48px auto 0">
        <span class="label">Can’t join</span>
        <h2>${esc(msg)}</h2>
        <div class="dlg__actions" style="justify-content:flex-start"><a class="btn btn--primary" href="#/private">Try another code</a><a class="btn btn--tonal" href="#/">Home</a></div>
      </div>`;
  }

  async function syncClock() {
    let best = { rtt: Infinity, offset: 0 };
    for (let i = 0; i < 4; i++) {
      const t0 = Date.now();
      const st = await new Promise((r) => S.socket.timeout(3000).emit('time', (err, t) => r(err ? null : t)));
      const t1 = Date.now();
      if (st && t1 - t0 < best.rtt) best = { rtt: t1 - t0, offset: st + (t1 - t0) / 2 - t1 };
    }
    S.offset = best.offset;
  }

  function connect() {
    const opts = { auth: { token }, transports: ['websocket', 'polling'] };
    S.socket = API_BASE ? window.io(API_BASE, opts) : window.io(opts);
    let joinedOnce = false;

    S.socket.on('connect_error', (err) => {
      if (err.message === 'unauthorized') { toast('Please sign in again.'); location.hash = '#/login'; }
      else if (err.message === 'rate-limited') toast('Too many reconnects. Waiting a moment before trying again.', 5000);
      else if (err.message === 'too-many-connections') toast('Too many Duet tabs open on your network. Close some and reload.', 6000);
    });
    S.socket.on('connect', async () => {
      for (const sid of [...S.peers.keys()]) closePeer(sid);
      await Promise.all([syncClock(), loadIce()]);
      S.socket.emit('join', { code }, async (res) => {
        if (S.disposed) return;
        if (res.error) { S.socket.disconnect(); showError(res.error); return; }
        S.room = res.room;
        els.name.textContent = res.room.name;
        els.kind.textContent = res.room.type === 'private' ? `Private room · up to ${res.room.capacity}` : 'Public room · up to 10';
        $('r-code').textContent = res.room.code;
        $('r-codechip').hidden = false;
        $('r-share').hidden = false;
        if (!joinedOnce && sessionStorage.getItem('duet.justCreated') === res.room.code) {
          sessionStorage.removeItem('duet.justCreated');
          $('d-share-code').textContent = res.room.code;
          $('d-share').showModal();
        }
        if (joinedOnce) toast('Reconnected.');
        joinedOnce = true;
        // Tell the room our current mic/camera state (matters after a reconnect).
        S.socket.emit('state', { mic: !S.micMuted, cam: !!S.camTrack });
        setRecorders(res.recorders || []);
        (res.chat || []).forEach(addChat);
        S.queue = res.queue || [];
        renderQueue();
        renderTiles();
        for (const p of res.peers) { S.pendingInfo.set(p.socketId, p); callPeer(p).catch((e) => console.warn(e)); }
        if (res.media?.videoId) applyMedia(res.media);
      });
    });
    S.socket.on('disconnect', (reason) => {
      if (!S.disposed && reason !== 'io client disconnect') toast('Connection lost. Reconnecting…');
    });
    S.socket.on('peer-joined', (p) => {
      S.pendingInfo.set(p.socketId, p);
      addChat({ system: true, text: `${p.username} joined the room` });
    });
    S.socket.on('peer-left', ({ socketId }) => {
      const p = S.peers.get(socketId) || S.pendingInfo.get(socketId);
      if (p) addChat({ system: true, text: `${p.username} left` });
      S.pendingInfo.delete(socketId);
      closePeer(socketId);
      renderTiles();
      tuneAllSenders(); // fewer people → video quality can step back up
    });
    S.socket.on('peer-state', ({ socketId, cam, mic }) => {
      const info = S.pendingInfo.get(socketId);
      if (info) Object.assign(info, { cam, mic });
      const p = S.peers.get(socketId);
      if (p) { p.cam = cam; p.mic = mic; renderTiles(); }
    });
    S.socket.on('signal', onSignal);
    S.socket.on('media', (m) => {
      if ((m.event === 'load' || m.event === 'next') && S.rec) stopRecording('switched');
      if (m.event === 'load' && m.by && m.by !== me.username) addChat({ system: true, text: `${m.by} put on a new song` });
      if (m.event === 'next') { addChat({ system: true, text: `Up next: ${m.title || 'the next song'}` }); toast(`Up next: ${m.title || 'the next song'}`); }
      applyMedia(m);
    });
    S.socket.on('queue', (list) => { S.queue = Array.isArray(list) ? list : []; renderQueue(); });
    S.socket.on('recorders', setRecorders);
    S.socket.on('react', ({ emoji, username }) => floatReaction(emoji, username));
    S.socket.on('chat', addChat);
    S.socket.on('chat-error', ({ error }) => toast(error));
    S.socket.on('slow-down', () => toast('Easy there. Some of your clicks were ignored.'));
  }

  // share buttons
  // origin + path, so it works under https://<user>.github.io/<repo>/ too
  const inviteLink = () => `${location.origin}${location.pathname}#/room/${S.room?.code}`;
  $('r-copycode')?.addEventListener('click', () => copy(S.room.code, 'Room code copied'));
  $('r-share')?.addEventListener('click', () => copy(inviteLink(), 'Invite link copied'));
  $('d-share-copy')?.addEventListener('click', () => copy(S.room.code, 'Room code copied'));
  $('d-share-link')?.addEventListener('click', () => copy(inviteLink(), 'Invite link copied'));

  // leave guard while recording
  const onBeforeUnload = (e) => { if (S.rec) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);

  // ---------- boot ----------
  renderTiles();
  renderQueue();
  // Test hook for automated load / browser tests. Only on when this browser has duet.debug=1 set.
  try { if (localStorage.getItem('duet.debug') === '1') window.__duet = { S, curTime, expectedPos }; } catch {}
  (async () => {
    await initMic();
    if (S.disposed) return;
    renderTiles();
    meterLoop();
    if (!solo) connect();
  })();

  // ---------- cleanup ----------
  return () => {
    S.disposed = true;
    if (S.rec) {
      clearInterval(S.rec.voiceTimer);
      clearInterval(S.rec.drawTimer);
      try { S.rec.recorder.stop(); } catch {}
      S.rec.display?.getTracks().forEach((t) => t.stop());
      S.rec.recMic?.getTracks().forEach((t) => t.stop());
    }
    exportAbort?.abort();
    cancelAnimationFrame(S.raf);
    S.timers.forEach(clearInterval);
    window.removeEventListener('beforeunload', onBeforeUnload);
    for (const ev of UNLOCK_EVENTS) document.removeEventListener(ev, resumeCtx, { capture: true });
    for (const sid of [...S.peers.keys()]) closePeer(sid);
    if (S.socket) { S.socket.emit('leave'); S.socket.disconnect(); }
    S.localStream?.getTracks().forEach((t) => t.stop());
    S.camTrack?.stop();
    try { S.player?.destroy(); } catch {}
    try { S.ctx?.close(); } catch {}
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
  };
}
