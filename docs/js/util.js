// Small helpers shared by every screen.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const uid = () => {
  const a = new Uint32Array(2);
  crypto.getRandomValues(a);
  return (a[0].toString(36) + a[1].toString(36)).padStart(10, 'x').slice(0, 10);
};

/** 75.4 -> "1:15" (or "1:15.4" with tenths) */
export function clock(seconds, tenths = false) {
  const s = Math.max(0, Number(seconds) || 0);
  const whole = tenths ? Math.floor(s * 10) / 10 : Math.round(s);
  const m = Math.floor(whole / 60);
  const rest = whole - m * 60;
  const ss = tenths ? rest.toFixed(1).padStart(4, '0') : String(Math.round(rest)).padStart(2, '0');
  return `${m}:${ss}`;
}

/** 75 -> "1 min 15 sec" */
export function spoken(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (!m) return `${r} sec`;
  return r ? `${m} min ${r} sec` : `${m} min`;
}

export function megabytes(bytes) {
  const mb = bytes / 1048576;
  return mb >= 100 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

export function debounce(fn, ms) {
  let timer;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  wrapped.now = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  return wrapped;
}

/** Turns "Tum_Hi_Ho Karaoke With Lyrics [HD] (abc123).mp4" into "Tum Hi Ho". */
export function titleFromFileName(name) {
  const bare = String(name).replace(/\.[a-z0-9]{2,5}$/i, '');
  let s = bare.replace(/_+/g, ' ');
  s = s.replace(/\[[^\]]*\]|\([^)]*\)|【[^】]*】|\{[^}]*\}/g, ' ');
  s = s.split(/[|｜]/)[0];
  s = s
    .replace(/\b(with\s+)?(scrolling\s+)?lyrics?\b/gi, ' ')
    .replace(/\b(full\s+)?(video\s+)?karaoke(\s+(version|track|song|music))?\b/gi, ' ')
    .replace(/\b(instrumental|unplugged|hd|hq|4k|1080p|720p|480p|360p)\b/gi, ' ');
  s = s.replace(/\s{2,}/g, ' ').replace(/^[\s\-–—:,.&]+|[\s\-–—:,.&]+$/g, '');
  return s.length >= 2 ? s : bare.trim() || 'Song';
}

export function safeFileName(name, fallback = 'My fusion') {
  const s = String(name || '').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 60);
  return s || fallback;
}

// ------------------------------------------------------------------ icons

const PATHS = {
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.3c-.8.5-1.2 1-1.2 1.9"/><path d="M12 17.2h.01"/>',
  up: '<path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/>',
  down: '<path d="M12 5v14M5.5 12.5 12 19l6.5-6.5"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l.8 12.5h9.4L17.500 7M10 11v5.500M14 11v5.500"/>',
  scissors: '<circle cx="6" cy="6.500" r="2.800"/><circle cx="6" cy="17.500" r="2.800"/><path d="M8.300 8.200 20 17M8.300 15.800 20 7"/>',
  grip: '<g fill="currentColor" stroke="none"><circle cx="9" cy="6" r="1.600"/><circle cx="15" cy="6" r="1.600"/><circle cx="9" cy="12" r="1.600"/><circle cx="15" cy="12" r="1.600"/><circle cx="9" cy="18" r="1.600"/><circle cx="15" cy="18" r="1.600"/></g>',
  play: '<path d="M8 5v14l11-7z" fill="currentColor"/>',
  pause: '<path d="M8.500 5.500v13M15.500 5.500v13" stroke-width="3.400"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M5 12.500 9.500 17 19 7.500"/>',
  download: '<path d="M12 4v11M7 10.500l5 5 5-5M5 20h14"/>',
  share: '<circle cx="6.500" cy="12" r="2.500"/><circle cx="17" cy="6" r="2.500"/><circle cx="17" cy="18" r="2.500"/><path d="M8.700 10.800 14.800 7.200M8.700 13.200l6.100 3.600"/>',
  film: '<rect x="3" y="5" width="18" height="14" rx="2.500"/><path d="M10 9.200v5.600l4.800-2.800z" fill="currentColor"/>',
  music: '<path d="M9 17.500V6l10-2v11.500"/><circle cx="6.500" cy="17.500" r="2.500"/><circle cx="16.500" cy="15.500" r="2.500"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  right: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  join: '<path d="M12 3.500v17M7 15.500l5 5 5-5"/>',
  speaker: '<path d="M4 9.500v5h3.500L12 18.500v-13L7.500 9.500z"/><path d="M15.500 9a4.200 4.200 0 0 1 0 6M18 6.500a7.800 7.800 0 0 1 0 11"/>',
  folder: '<path d="M3 7.500a2 2 0 0 1 2-2h4l2 2.200h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  eye: '<path d="M2.500 12S6 5.500 12 5.500 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12z"/><circle cx="12" cy="12" r="2.800"/>',
  warn: '<path d="M12 4 2.800 19.500h18.400z"/><path d="M12 10v4.500M12 17.200h.01"/>',
};

export const icon = (name) => `<svg class="ic" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name] || ''}</svg>`;

/** Fills every element that has data-icon="name" with that icon (placed before its text). */
export function paintIcons(root = document) {
  for (const el of $$('[data-icon]', root)) {
    if (!el.querySelector(':scope > svg.ic')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  }
}

// ------------------------------------------------------------------ messages

let toastTimer;

/** A short message at the bottom of the screen, optionally with one button (for example Undo). */
export function toast(message, { action, onAction, ms = 4000 } = {}) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  el.hidden = false;
  el.classList.add('show');
  const button = el.querySelector('button');
  if (button) {
    button.onclick = () => {
      hide();
      onAction?.();
    };
  }
  clearTimeout(toastTimer);
  function hide() {
    el.classList.remove('show');
    el.hidden = true;
  }
  toastTimer = setTimeout(hide, action ? Math.max(ms, 6000) : ms);
}

/** A simple question box. Resolves true when the main button is pressed. */
export function ask({ title, text = '', yes = 'OK', no = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const box = $('#modal-ask');
    $('#ask-title').textContent = title;
    $('#ask-text').textContent = text;
    $('#ask-text').hidden = !text;
    const yesBtn = $('#ask-yes');
    const noBtn = $('#ask-no');
    yesBtn.textContent = yes;
    yesBtn.className = `btn ${danger ? 'danger' : 'primary'}`;
    noBtn.textContent = no;
    noBtn.hidden = !no;
    const done = (value) => {
      box.hidden = true;
      yesBtn.onclick = noBtn.onclick = null;
      resolve(value);
    };
    yesBtn.onclick = () => done(true);
    noBtn.onclick = () => done(false);
    box.hidden = false;
    yesBtn.focus({ preventScroll: true });
  });
}

export const tell = (title, text = '') => ask({ title, text, yes: 'OK', no: '' });
