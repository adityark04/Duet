// Keep ?v= in step with index.html and room.js (the same URL = the same module instance).
import { mountRoom } from './room.js?v=14';

// ---------- state ----------
const store = {
  get token() { try { return localStorage.getItem('duet.token'); } catch { return null; } },
  set token(v) { try { v ? localStorage.setItem('duet.token', v) : localStorage.removeItem('duet.token'); } catch {} },
};
let me = null;
let cleanup = null;

const main = document.getElementById('main');
const nav = document.getElementById('nav');

// ---------- helpers ----------
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Server address: '' = this site; on GitHub Pages it's the hosted server (see config.js).
export const API_BASE = String(window.DUET_CONFIG?.apiBase || '').replace(/\/+$/, '');

// Free servers sleep when idle and take up to a minute to wake. Say so instead of looking broken.
let wakeShown = false;
export async function apiFetch(path, init) {
  const slow = setTimeout(() => {
    if (!wakeShown) { wakeShown = true; toast('Waking up the server. This can take up to a minute the first time.', 8000); }
  }, 3500);
  try {
    return await fetch(API_BASE + path, init);
  } catch {
    throw new Error(API_BASE ? 'Can’t reach the Duet server. It may be starting up; try again in a moment.' : 'Can’t reach the server.');
  } finally { clearTimeout(slow); }
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await apiFetch(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(store.token ? { Authorization: `Bearer ${store.token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { signOut(); }
  if (!res.ok) { const e = new Error(data.error || 'Something went wrong. Try again.'); e.data = data; e.status = res.status; throw e; }
  return data;
}

let toastTimer;
export function toast(msg, ms = 2600) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('is-on'), ms);
}

export async function copy(text, label = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch { toast('Copy failed. Select and copy it by hand.'); }
}

// Avatar colours: deep lounge tones, all readable with white initials.
const PALETTE = ['#A8462E', '#2E6A7A', '#3E7A55', '#94652A', '#8A3A4E', '#2F5C8A', '#6B5A2E', '#4E6E6A', '#7A3E2C', '#3D5670'];

// A spinning record for the sign-in page.
function vinylSVG() {
  const grooves = [];
  for (let r = 70; r <= 188; r += 6) grooves.push(`<circle cx="200" cy="200" r="${r}" fill="none" stroke="#F2E8D5" stroke-opacity="${r % 30 === 0 ? 0.09 : 0.035}"/>`);
  return `
    <div class="vinyl" aria-hidden="true">
      <svg class="vinyl__disc" viewBox="0 0 400 400">
        <circle cx="200" cy="200" r="196" fill="#07090E"/>
        <circle cx="200" cy="200" r="196" fill="none" stroke="#E3A857" stroke-opacity=".25"/>
        ${grooves.join('')}
        <path d="M200 20 A180 180 0 0 1 356 110" stroke="#F2E8D5" stroke-opacity=".16" stroke-width="10" fill="none" stroke-linecap="round"/>
        <path d="M200 380 A180 180 0 0 1 44 290" stroke="#F2E8D5" stroke-opacity=".08" stroke-width="10" fill="none" stroke-linecap="round"/>
        <circle cx="200" cy="200" r="62" fill="#E3A857"/>
        <circle cx="200" cy="200" r="54" fill="none" stroke="#1A1206" stroke-opacity=".25"/>
        <text x="200" y="186" text-anchor="middle" font-family="Fraunces, serif" font-style="italic" font-size="26" fill="#1A1206">Duet</text>
        <text x="200" y="226" text-anchor="middle" font-family="Instrument Sans, sans-serif" font-size="10" fill="#1A1206" fill-opacity=".7">Side A · late set</text>
        <circle cx="200" cy="200" r="5" fill="#07090E"/>
      </svg>
      <svg class="vinyl__arm" viewBox="0 0 200 260" fill="none">
        <circle cx="156" cy="30" r="22" fill="#1B2233" stroke="#E3A857" stroke-opacity=".5"/>
        <circle cx="156" cy="30" r="7" fill="#E3A857"/>
        <path d="M156 30 L120 200 L92 236" stroke="#CFC3AE" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
        <rect x="70" y="226" width="34" height="22" rx="4" transform="rotate(-40 87 237)" fill="#CFC3AE"/>
      </svg>
    </div>`;
}

// Line drawings for the three ways to sing.
const ART = {
  solo: `<svg viewBox="0 0 140 112" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M70 4 L28 108 H112 Z" fill="currentColor" fill-opacity=".08" stroke="none"/>
    <rect x="61" y="22" width="18" height="30" rx="9" fill="currentColor" fill-opacity=".15"/>
    <path d="M61 33h18M61 41h18"/>
    <path d="M55 44a15 15 0 0 0 30 0"/>
    <path d="M70 59v41M54 104h32"/>
  </svg>`,
  public: `<svg viewBox="0 0 180 112" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <g><path d="M30 34 l-10 16h20z" fill="currentColor" fill-opacity=".2"/><path d="M30 26v8M30 50v24"/><ellipse cx="30" cy="78" rx="22" ry="5"/><path d="M30 83v20M22 104h16"/></g>
    <g><path d="M90 24 l-11 18h22z" fill="currentColor" fill-opacity=".2"/><path d="M90 14v10M90 42v32"/><ellipse cx="90" cy="78" rx="24" ry="5.5"/><path d="M90 84v19M81 104h18"/></g>
    <g><path d="M150 34 l-10 16h20z" fill="currentColor" fill-opacity=".2"/><path d="M150 26v8M150 50v24"/><ellipse cx="150" cy="78" rx="22" ry="5"/><path d="M150 83v20M142 104h16"/></g>
    <circle cx="30" cy="50" r="14" fill="currentColor" fill-opacity=".06" stroke="none"/><circle cx="90" cy="42" r="18" fill="currentColor" fill-opacity=".08" stroke="none"/><circle cx="150" cy="50" r="14" fill="currentColor" fill-opacity=".06" stroke="none"/>
  </svg>`,
  private: `<svg viewBox="0 0 140 112" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M38 108V16a6 6 0 0 1 6-6h52a6 6 0 0 1 6 6v92"/>
    <path d="M30 108h80"/>
    <rect x="52" y="26" width="36" height="12" rx="3" fill="currentColor" fill-opacity=".15"/>
    <path d="M58 32h24" stroke-dasharray="3 4"/>
    <circle cx="90" cy="66" r="3" fill="currentColor"/>
    <rect x="52" y="48" width="26" height="40" rx="2" stroke-opacity=".4"/>
  </svg>`,
};

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Still up';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}
export function colorFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
export const initials = (name) => String(name || '?').slice(0, 2).toUpperCase();

const ARROW = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 10h12M11 5l5 5-5 5"/></svg>';
const BACK = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 10H4M9 5l-5 5 5 5"/></svg>';

function setNav(show) {
  nav.hidden = !show;
  if (show && me) {
    document.getElementById('idchip-value').textContent = me.id;
    document.getElementById('nav-user').textContent = me.username;
  }
}

function signOut() {
  store.token = null;
  me = null;
  location.hash = '#/login';
}

document.getElementById('signout').addEventListener('click', signOut);
document.getElementById('idchip').addEventListener('click', () => copy(me?.id || '', 'Your ID is copied'));

// ---------- views ----------
function viewAuth(mode) {
  setNav(false);
  const isSignup = mode === 'signup';
  main.innerHTML = `
    <section class="page page--bare">
      <div class="wrap auth">
        <div class="auth__copy enter">
          <a class="brand" href="#/login" aria-label="Duet">
            <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true"><circle cx="16" cy="16" r="15" fill="#080A11" stroke="#E3A857" stroke-opacity=".5"/><circle cx="16" cy="16" r="11.5" fill="none" stroke="#F2E8D5" stroke-opacity=".14"/><circle cx="16" cy="16" r="6" fill="#E3A857"/><circle cx="16" cy="16" r="1.5" fill="#080A11"/></svg>
            <span>duet</span>
          </a>
          <span class="label label--lamp">Open late, every night</span>
          <h1>Karaoke for friends who live <em>miles apart.</em></h1>
          <p class="lead measure">Dim the lights, paste a lyrics video from YouTube, and sing over the same track while you hear each other live. Record the whole song and keep it.</p>
          <div class="facts">
            <div><div class="fact__n">10</div><div class="fact__l">voices per room</div></div>
            <div><div class="fact__n">5</div><div class="fact__l">character room codes</div></div>
            <div><div class="fact__n">1</div><div class="fact__l">click to record</div></div>
          </div>
        </div>
        <div class="auth__right enter">
        ${vinylSVG()}
        <div class="auth__card">
          <div style="display:grid;gap:8px">
            <h2>${isSignup ? 'Get on the <em>list</em>' : 'Welcome <em>back</em>'}</h2>
            <p class="muted">${isSignup ? 'You’ll get your own Duet ID right after.' : 'Sign in to pick up where you left off.'}</p>
          </div>
          <form class="form" id="authform" novalidate>
            <div class="field">
              <label for="username">Name</label>
              <input class="input" id="username" name="username" autocomplete="username" required minlength="3" maxlength="20" placeholder="e.g. aditya">
              <div class="field__error" id="err-username"></div>
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input class="input" id="password" name="password" type="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" required minlength="6">
              ${isSignup ? '<div class="field__hint">At least 6 characters.</div>' : ''}
              <div class="field__error" id="err-password"></div>
            </div>
            <div class="form__status" role="status" id="authstatus"></div>
            <button class="btn btn--primary btn--block btn--lg" type="submit">${isSignup ? 'Create account' : 'Sign in'}</button>
          </form>
          <p class="auth__switch">${isSignup ? 'Have an account? <a href="#/login">Sign in</a>' : 'New here? <a href="#/signup">Create an account</a>'}</p>
        </div>
        </div>
      </div>
    </section>`;

  const form = document.getElementById('authform');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    ['username', 'password'].forEach((k) => (document.getElementById(`err-${k}`).textContent = ''));
    document.getElementById('authstatus').textContent = '';
    const body = { username: form.username.value.trim(), password: form.password.value };
    if (!body.username) { document.getElementById('err-username').textContent = 'Enter your name.'; return; }
    if (!body.password) { document.getElementById('err-password').textContent = 'Enter your password.'; return; }
    btn.disabled = true;
    try {
      const data = await api(isSignup ? '/api/signup' : '/api/login', { method: 'POST', body });
      store.token = data.token;
      me = data.user;
      location.hash = isSignup ? '#/welcome' : (sessionStorage.getItem('duet.next') || '#/');
      sessionStorage.removeItem('duet.next');
    } catch (err) {
      const errs = err.data?.errors;
      if (errs) Object.entries(errs).forEach(([k, v]) => { const el = document.getElementById(`err-${k}`); if (el) el.textContent = v; });
      else document.getElementById('authstatus').textContent = err.message;
    } finally { btn.disabled = false; }
  });
}

function viewWelcome() {
  setNav(true);
  main.innerHTML = `
    <section class="page">
      <div class="wrap" style="max-width:640px">
        <div class="panel reveal enter">
          <span class="label">Account created</span>
          <h2>Hi ${esc(me.username)}, this is your Duet ID.</h2>
          <div class="reveal__id" id="myid">${esc(me.id)}</div>
          <p class="muted">Share it with friends so they know it’s you in a room. You can copy it from the top bar any time.</p>
          <div class="dlg__actions" style="justify-content:flex-start">
            <a class="btn btn--primary" href="#/">Start singing ${ARROW}</a>
            <button class="btn btn--tonal" type="button" id="copyid">Copy ID</button>
          </div>
        </div>
      </div>
    </section>`;
  document.getElementById('copyid').addEventListener('click', () => copy(me.id, 'Your ID is copied'));
}

function viewHome() {
  setNav(true);
  main.innerHTML = `
    <section class="page">
      <div class="wrap">
        <div class="head enter">
          <span class="label label--lamp">${greeting()}, ${esc(me.username)}</span>
        </div>
        <div class="hero enter">
          <h1>Sing together, <em>wherever</em> you are.</h1>
          <div class="hero__row">
            <div class="hero__ctas">
              <a class="btn btn--primary btn--lg" href="#/private">Start a private room</a>
              <a class="btn btn--line btn--lg" href="#/public">Browse public rooms</a>
            </div>
            <p class="hero__note">The lights are low and the mic is warm. Line up songs, see each other on camera, and record the whole night.</p>
            <a class="capsule" href="#/solo" aria-label="Sing solo">
              <span class="capsule__play"><svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path d="M6 4.5v11a.8.8 0 0 0 1.2.7l8.6-5.5a.8.8 0 0 0 0-1.4L7.2 3.8A.8.8 0 0 0 6 4.5Z"/></svg></span>
              <span class="capsule__t"><strong>Solo spotlight</strong><span>Warm up on your own</span></span>
              <span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
            </a>
          </div>
        </div>
        <div class="modes enter">
          <a class="mode" href="#/solo">
            <div class="mode__art">${ART.solo}</div>
            <div style="display:grid;gap:8px;align-content:start"><h3>Solo spotlight</h3><p class="mode__text">Just you, a lyrics video and your mic. Record a take and download it.</p></div>
            <div class="mode__foot"><span>Sing alone</span><span class="mode__arrow">${ARROW}</span></div>
          </a>
          <a class="mode" href="#/public">
            <div class="mode__art">${ART.public}</div>
            <div style="display:grid;gap:8px;align-content:start"><h3>Public lounge</h3><p class="mode__text">Join an open room anyone can walk into, or start one. Up to 10 people each.</p></div>
            <div class="mode__foot"><span>Browse rooms</span><span class="mode__arrow">${ARROW}</span></div>
          </a>
          <a class="mode mode--feature" href="#/private">
            <div class="mode__art">${ART.private}</div>
            <div style="display:grid;gap:8px;align-content:start"><h3>Private room</h3><p class="mode__text">Pick a size from 5 to 10 people. Only friends with your 5-character code get past the door.</p></div>
            <div class="mode__foot"><span>Create or join</span><span class="mode__arrow">${ARROW}</span></div>
          </a>
        </div>
        <div class="joinbar enter">
          <div><h3 style="font-size:22px">Got a room code?</h3><p class="muted" style="font-size:14px">Five letters and numbers, like K7Q2M.</p></div>
          <form id="quickjoin" novalidate>
            <label class="label" for="qcode" style="position:absolute;left:-9999px">Room code</label>
            <input class="input input--code" id="qcode" maxlength="5" autocomplete="off" spellcheck="false" placeholder="•••••">
            <button class="btn btn--dark" type="submit">Join room</button>
          </form>
        </div>
      </div>
    </section>`;
  bindCodeInput(document.getElementById('qcode'));
  document.getElementById('quickjoin').addEventListener('submit', (e) => { e.preventDefault(); joinByCode(document.getElementById('qcode').value); });
}

function bindCodeInput(input) {
  input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });
}

async function joinByCode(raw) {
  const code = String(raw || '').toUpperCase().trim();
  if (!/^[A-Z0-9]{5}$/.test(code)) { toast('Room codes are 5 letters or numbers.'); return; }
  try {
    const { room } = await api(`/api/rooms/${code}`);
    if (room.members >= room.capacity) { toast(`That room is full (${room.capacity} of ${room.capacity}).`); return; }
    location.hash = `#/room/${code}`;
  } catch (err) { toast(err.message); }
}

function viewPublic() {
  setNav(true);
  main.innerHTML = `
    <section class="page">
      <div class="wrap" style="max-width:960px">
        <a class="back" href="#/">${BACK} Home</a>
        <div class="head enter" style="grid-template-columns:1fr auto;align-items:end">
          <div style="display:grid;gap:16px"><h1 style="font-size:clamp(36px,4.4vw,56px)">Public rooms</h1><p class="lead">Anyone signed in can join these. Each holds up to 10 singers.</p></div>
        </div>
        <form class="panel enter" id="newpublic" style="grid-template-columns:1fr auto;align-items:end;margin-bottom:24px" novalidate>
          <div class="field"><label for="pname">Start your own</label><input class="input" id="pname" maxlength="40" placeholder="Room name, e.g. Friday 90s night"></div>
          <button class="btn btn--primary" type="submit">Start public room</button>
        </form>
        <div class="rooms" id="roomlist" aria-live="polite"><div class="empty">Loading rooms…</div></div>
      </div>
    </section>`;
  const list = document.getElementById('roomlist');
  const load = async () => {
    try {
      const { rooms } = await api('/api/rooms/public');
      if (!rooms.length) {
        list.innerHTML = `<div class="empty"><strong style="color:var(--ink)">No public rooms right now.</strong><span>Start one above and it shows up here for everyone.</span></div>`;
        return;
      }
      list.innerHTML = rooms.map((r) => `
        <div class="roomrow">
          <div><div class="roomrow__name">${esc(r.name)}</div><div class="roomrow__meta">Hosted by ${esc(r.hostName)}${r.nowPlaying ? ` · Now playing ${esc(r.nowPlaying)}` : ''}</div></div>
          <span class="count"><span class="dot"></span>${r.members} of ${r.capacity}</span>
          ${r.members >= r.capacity ? '<button class="btn btn--tonal btn--sm" disabled>Full</button>' : `<a class="btn btn--line btn--sm" href="#/room/${r.code}">Join</a>`}
        </div>`).join('');
    } catch (err) { list.innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
  };
  load();
  const timer = setInterval(load, 5000);
  document.getElementById('newpublic').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const { room } = await api('/api/rooms', { method: 'POST', body: { type: 'public', name: document.getElementById('pname').value } });
      location.hash = `#/room/${room.code}`;
    } catch (err) { toast(err.message); }
  });
  return () => clearInterval(timer);
}

function viewPrivate() {
  setNav(true);
  main.innerHTML = `
    <section class="page">
      <div class="wrap" style="max-width:1040px">
        <a class="back" href="#/">${BACK} Home</a>
        <div class="head enter"><h1 style="font-size:clamp(36px,4.4vw,56px)">Private room</h1><p class="lead measure">Only people with the 5-character code can get in. Share it in your group chat.</p></div>
        <div class="split enter">
          <form class="panel" id="create" novalidate>
            <div style="display:grid;gap:4px"><h2 style="font-size:24px">Create a room</h2><p class="muted">You’ll get a code to share.</p></div>
            <div class="field"><label for="rname">Room name</label><input class="input" id="rname" maxlength="40" placeholder="e.g. Cousins’ karaoke"></div>
            <fieldset class="field" style="border:0;padding:0;margin:0">
              <legend style="font-size:14px;font-weight:500;margin-bottom:8px">How many people, including you?</legend>
              <div class="seg">
                ${[5, 6, 7, 8, 9, 10].map((n) => `<input type="radio" name="cap" id="cap${n}" value="${n}" ${n === 5 ? 'checked' : ''}><label for="cap${n}">${n}</label>`).join('')}
              </div>
            </fieldset>
            <button class="btn btn--primary btn--block" type="submit">Create private room</button>
          </form>
          <form class="panel" id="join" novalidate>
            <div style="display:grid;gap:4px"><h2 style="font-size:24px">Join with a code</h2><p class="muted">Ask the host for their room code.</p></div>
            <div class="field"><label for="jcode">Room code</label><input class="input input--code" id="jcode" maxlength="5" autocomplete="off" spellcheck="false" placeholder="•••••" style="height:64px;font-size:28px"></div>
            <button class="btn btn--dark btn--block" type="submit">Join room</button>
          </form>
        </div>
      </div>
    </section>`;
  bindCodeInput(document.getElementById('jcode'));
  document.getElementById('join').addEventListener('submit', (e) => { e.preventDefault(); joinByCode(document.getElementById('jcode').value); });
  document.getElementById('create').addEventListener('submit', async (e) => {
    e.preventDefault();
    const capacity = Number(new FormData(e.target).get('cap'));
    try {
      const { room } = await api('/api/rooms', { method: 'POST', body: { type: 'private', capacity, name: document.getElementById('rname').value } });
      sessionStorage.setItem('duet.justCreated', room.code);
      location.hash = `#/room/${room.code}`;
    } catch (err) { toast(err.message); }
  });
}

// ---------- router ----------
async function route() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  const hash = location.hash || '#/';
  const [, page, arg] = hash.split('/');

  if (page === 'login' || page === 'signup') {
    if (store.token && me) { location.hash = '#/'; return; }
    viewAuth(page);
    return;
  }

  if (!store.token) {
    if (hash.startsWith('#/room/')) sessionStorage.setItem('duet.next', hash);
    location.hash = '#/login';
    return;
  }
  if (!me) {
    try { me = (await api('/api/me')).user; }
    catch { return; }
  }

  window.scrollTo(0, 0);
  if (page === 'welcome') viewWelcome();
  else if (page === 'public') cleanup = viewPublic();
  else if (page === 'private') viewPrivate();
  else if (page === 'solo') { setNav(true); cleanup = mountRoom(main, { solo: true, me, token: store.token }); }
  else if (page === 'room' && arg) { setNav(true); cleanup = mountRoom(main, { code: arg.toUpperCase(), me, token: store.token }); }
  else viewHome();
  main.focus({ preventScroll: true });
}

window.addEventListener('hashchange', route);
route();
