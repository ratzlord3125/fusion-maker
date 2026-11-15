// The "choose the part to keep" screen: the song plays in a video player, and the person
// marks where their part starts and ends.
import { $, clamp, clock, spoken, icon } from './util.js';

const MIN_PART = 3; // seconds: the shortest part that can be kept
const NUDGE = 0.5;

let cur = null;
let frameRequest = 0;
let wantedSeek = null;
const el = {};

const now = () => (cur.videoOk ? el.video.currentTime : cur.pos);

function seek(t) {
  t = clamp(t, 0, cur.duration);
  cur.pos = t;
  if (!cur.videoOk) return;
  // While a finger drags a handle many seeks arrive; only the newest one matters.
  if (el.video.seeking) wantedSeek = t;
  else el.video.currentTime = t;
}

function pause() {
  cur.playUntil = null;
  if (cur.videoOk) el.video.pause();
}

function playFrom(t, until = null) {
  if (!cur.videoOk) return;
  el.video.currentTime = clamp(t, 0, cur.duration);
  cur.playUntil = until;
  el.video.play().catch(() => {});
}

function draw() {
  const pct = (t) => `${(clamp(t / cur.duration, 0, 1) * 100).toFixed(3)}%`;
  el.sel.style.left = pct(cur.start);
  el.sel.style.width = pct(cur.end - cur.start);
  el.hStart.style.left = pct(cur.start);
  el.hEnd.style.left = pct(cur.end);
  el.startTime.textContent = clock(cur.start, true);
  el.endTime.textContent = clock(cur.end, true);
  el.total.textContent = clock(cur.duration);
  const whole = cur.start < 0.05 && cur.end > cur.duration - 0.05;
  el.length.textContent = whole ? `The whole song will play (${spoken(cur.duration)}).` : `Your part plays for ${spoken(cur.end - cur.start)}.`;
}

function tick() {
  if (!cur) return;
  const t = now();
  el.head.style.left = `${(clamp(t / cur.duration, 0, 1) * 100).toFixed(3)}%`;
  el.now.textContent = clock(t, true);
  const playing = cur.videoOk && !el.video.paused && !el.video.ended;
  if (playing !== cur.shownPlaying) {
    cur.shownPlaying = playing;
    el.play.innerHTML = `${icon(playing ? 'pause' : 'play')}<span>${playing ? 'Pause' : 'Play'}</span>`;
  }
  if (playing && cur.playUntil !== null && t >= cur.playUntil) {
    el.video.pause();
    cur.playUntil = null;
  }
  frameRequest = requestAnimationFrame(tick);
}

function timeAt(clientX) {
  const box = el.track.getBoundingClientRect();
  return clamp((clientX - box.left) / box.width, 0, 1) * cur.duration;
}

function setStart(t) {
  cur.start = clamp(t, 0, cur.end - MIN_PART);
  draw();
}

function setEnd(t) {
  cur.end = clamp(t, cur.start + MIN_PART, cur.duration);
  draw();
}

function flash(node) {
  node.classList.remove('flash');
  void node.offsetWidth; // restart the animation
  node.classList.add('flash');
}

function dragStart(e, what) {
  e.preventDefault();
  e.stopPropagation();
  pause();
  cur.drag = what;
  e.currentTarget.setPointerCapture(e.pointerId);
  dragMove(e);
}

function dragMove(e) {
  if (!cur?.drag) return;
  const t = timeAt(e.clientX);
  if (cur.drag === 'start') { setStart(t); seek(cur.start); }
  else if (cur.drag === 'end') { setEnd(t); seek(cur.end); }
  else seek(t);
}

function dragEnd() {
  if (cur) cur.drag = null;
}

export function initTrim() {
  Object.assign(el, {
    modal: $('#modal-trim'), video: $('#trim-video'), note: $('#trim-note'), title: $('#trim-title'),
    track: $('#trim-track'), sel: $('#trim-sel'), head: $('#trim-head'), hStart: $('#trim-h-start'), hEnd: $('#trim-h-end'),
    now: $('#trim-now'), total: $('#trim-total'), play: $('#trim-play'),
    startTime: $('#trim-start-time'), endTime: $('#trim-end-time'), length: $('#trim-length'),
    startBox: $('#trim-start-box'), endBox: $('#trim-end-box'),
  });

  el.video.addEventListener('loadedmetadata', () => {
    if (!cur) return;
    cur.videoOk = true;
    if (Number.isFinite(el.video.duration) && el.video.duration > 0 && Math.abs(el.video.duration - cur.duration) > 1) {
      // trust the player when the two disagree, so the handles match what is seen
      cur.duration = el.video.duration;
      cur.end = Math.min(cur.end, cur.duration);
      cur.start = clamp(cur.start, 0, Math.max(0, cur.end - MIN_PART));
    }
    el.note.hidden = !cur.soundOnly;
    el.video.currentTime = cur.start;
    draw();
  });
  el.video.addEventListener('error', () => {
    if (!cur) return;
    cur.videoOk = false;
    el.note.textContent = 'This phone cannot show a preview of this file. You can still set the start and end with the buttons below.';
    el.note.hidden = false;
  });
  el.video.addEventListener('seeked', () => {
    if (wantedSeek === null) return;
    const t = wantedSeek;
    wantedSeek = null;
    if (cur?.videoOk && Math.abs(el.video.currentTime - t) > 0.04) el.video.currentTime = t;
  });
  el.video.addEventListener('click', () => el.play.click());

  el.hStart.addEventListener('pointerdown', (e) => dragStart(e, 'start'));
  el.hEnd.addEventListener('pointerdown', (e) => dragStart(e, 'end'));
  el.track.addEventListener('pointerdown', (e) => dragStart(e, 'head'));
  for (const node of [el.hStart, el.hEnd, el.track]) {
    node.addEventListener('pointermove', dragMove);
    node.addEventListener('pointerup', dragEnd);
    node.addEventListener('pointercancel', dragEnd);
  }

  el.play.onclick = () => {
    if (!cur.videoOk) return;
    if (el.video.paused || el.video.ended) {
      cur.playUntil = null;
      if (el.video.ended) el.video.currentTime = cur.start;
      el.video.play().catch(() => {});
    } else {
      pause();
    }
  };
  $('#trim-back').onclick = () => seek(now() - 5);
  $('#trim-fwd').onclick = () => seek(now() + 5);

  $('#trim-set-start').onclick = () => { setStart(now()); flash(el.startBox); };
  $('#trim-set-end').onclick = () => { setEnd(now()); flash(el.endBox); };
  $('#trim-start-minus').onclick = () => { pause(); setStart(cur.start - NUDGE); seek(cur.start); };
  $('#trim-start-plus').onclick = () => { pause(); setStart(cur.start + NUDGE); seek(cur.start); };
  $('#trim-end-minus').onclick = () => { pause(); setEnd(cur.end - NUDGE); seek(cur.end); };
  $('#trim-end-plus').onclick = () => { pause(); setEnd(cur.end + NUDGE); seek(cur.end); };

  $('#trim-play-part').onclick = () => playFrom(cur.start, cur.end);
  $('#trim-play-end').onclick = () => playFrom(Math.max(cur.start, cur.end - 5), cur.end);
  $('#trim-whole').onclick = () => { cur.start = 0; cur.end = cur.duration; draw(); };
}

/**
 * options = { title, file (may be null), duration, start, end, soundOnly }
 * Returns what the person chose when they close the screen: { title, start, end }.
 */
export function openTrim(options) {
  cur = {
    duration: Math.max(MIN_PART, options.duration),
    start: options.start || 0,
    end: options.end || options.duration,
    pos: options.start || 0,
    soundOnly: !!options.soundOnly,
    videoOk: false,
    playUntil: null,
    drag: null,
    shownPlaying: null,
    url: null,
  };
  cur.end = clamp(cur.end, MIN_PART, cur.duration);
  cur.start = clamp(cur.start, 0, cur.end - MIN_PART);
  el.title.value = options.title || '';
  el.note.hidden = true;
  el.note.textContent = 'This file has sound only, so there is no picture.';
  wantedSeek = null;
  if (options.file) {
    cur.url = URL.createObjectURL(options.file);
    el.video.src = cur.url;
    el.video.load();
  } else {
    el.note.textContent = 'This song file is not on this phone, so it cannot be played.';
    el.note.hidden = false;
  }
  draw();
  cancelAnimationFrame(frameRequest);
  frameRequest = requestAnimationFrame(tick);
}

/** Stops playback and hands back the choice. Call when the screen is closed. */
export function closeTrim() {
  if (!cur) return null;
  cancelAnimationFrame(frameRequest);
  const result = { title: el.title.value.trim(), start: cur.start, end: cur.end, duration: cur.duration };
  el.video.pause();
  el.video.removeAttribute('src');
  el.video.load();
  if (cur.url) URL.revokeObjectURL(cur.url);
  cur = null;
  return result;
}
