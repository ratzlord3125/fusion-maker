// Fusion Maker - the screens and what happens when things are tapped.
import { $, $$, esc, clamp, uid, clock, spoken, megabytes, debounce, titleFromFileName, safeFileName, icon, paintIcons, toast, ask, tell } from './util.js';
import * as store from './store.js';
import { probe, FileProblem } from './media.js';
import { makePlan, estimateSeconds, MAX_SONGS } from './plan.js';
import { renderFusion, browserProblem, FusionError, deleteStoredFusions, openStoredFusion } from './engine.js';
import { decodeSound, forgetSound } from './audio.js';
import { DEFAULT_JOIN, describeJoin, mountJoinEditor, styleOf } from './joins.js';
import { initTrim, openTrim, closeTrim } from './trim.js';

const state = {
  project: null,
  step: 'songs',
  ownSounds: [],
  busy: null, // { controller } while a fusion is being made
  result: null, // { file, url, info } of the finished fusion
  joinIndex: -1,
  trimUid: null,
  againUid: null,
  preview: null,
  wakeLock: null,
  problem: '',
};

// ------------------------------------------------------------------ project data

function blankProject(name = 'My fusion') {
  return {
    id: uid(),
    name,
    tracks: [],
    join: { ...DEFAULT_JOIN },
    showNext: true,
    output: { kind: 'video', quality: '720', balance: true, fadeIn: true, fadeOut: true },
    lastExport: null,
    updatedAt: 0,
  };
}

function tidyJoin(j) {
  if (!j || typeof j !== 'object') return null;
  return { style: styleOf(j.style).id, duration: clamp(Math.round(Number(j.duration) || 3), 1, 6), sound: typeof j.sound === 'string' ? j.sound : '' };
}

/** Fills in anything missing, so old or hand-edited saves still open. */
function normalise(raw) {
  const base = blankProject();
  const p = { ...base, ...raw, output: { ...base.output, ...(raw.output || {}) } };
  p.id = typeof raw.id === 'string' && raw.id ? raw.id : base.id;
  p.name = String(p.name || 'My fusion').slice(0, 60);
  p.join = tidyJoin(p.join) || { ...DEFAULT_JOIN };
  p.tracks = (Array.isArray(raw.tracks) ? raw.tracks : []).filter((t) => t && t.fileId).map((t) => {
    const duration = Math.max(0, Number(t.duration) || 0);
    const end = clamp(Number(t.end) || duration, 0, duration);
    return {
      uid: t.uid || uid(),
      fileId: String(t.fileId),
      title: String(t.title || titleFromFileName(t.fileName || 'Song')).slice(0, 80),
      fileName: String(t.fileName || ''),
      fileSize: Number(t.fileSize) || 0,
      duration,
      start: clamp(Number(t.start) || 0, 0, Math.max(0, end - 1)),
      end,
      join: tidyJoin(t.join),
    };
  });
  return p;
}

const tracks = () => state.project.tracks;
const joinOf = (track) => track?.join || state.project.join;

function trackState(t) {
  if (t.busy) return 'busy';
  return store.hasFile(t.fileId) ? 'ready' : 'missing';
}

function clipSpec(t, over = {}) {
  return {
    fileId: t.fileId, start: t.start, end: t.end, duration: t.duration, title: t.title,
    audioRate: store.fileRecord(t.fileId)?.meta?.audioRate || 0, ...over,
  };
}

function buildSpec() {
  const p = state.project;
  return {
    kind: p.output.kind,
    quality: p.output.quality,
    clips: tracks().map((t) => clipSpec(t)),
    joins: tracks().slice(0, -1).map((t) => joinOf(t)),
    options: { showNext: p.showNext, balance: p.output.balance, fadeIn: p.output.fadeIn, fadeOut: p.output.fadeOut },
  };
}

// ------------------------------------------------------------------ saving

function showSaved(ok) {
  const el = $('#save-state');
  el.textContent = ok ? 'Saved' : 'Not saved: phone storage is full';
  el.classList.toggle('bad', !ok);
}

const saveSoon = debounce(() => {
  const p = state.project;
  showSaved(store.saveProject({ ...p, tracks: p.tracks.filter((t) => !t.busy).map(({ busy, ...t }) => t) }));
}, 500);

/** Call after any change the person makes. */
function touch() {
  $('#save-state').textContent = 'Saving…';
  saveSoon();
}

// ------------------------------------------------------------------ pop-up boxes (Back button closes them)

const openModals = [];
let skipPops = 0;

function showModal(el, onClose) {
  el.hidden = false;
  openModals.push({ el, onClose });
  history.pushState({ fusionModal: openModals.length }, '');
}

function hideModal(el) {
  const i = openModals.findIndex((m) => m.el === el);
  if (i < 0) return;
  const [m] = openModals.splice(i, 1);
  el.hidden = true;
  m.onClose?.();
  skipPops++;
  history.back();
}

window.addEventListener('popstate', () => {
  if (skipPops > 0) {
    skipPops--;
    return;
  }
  const m = openModals.pop();
  if (m) {
    m.el.hidden = true;
    m.onClose?.();
  }
});

// ------------------------------------------------------------------ layout

let lastWidth = -1;

function applyLayout() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (!w || !h) return;
  const a = document.activeElement;
  const typing = a && ((a.tagName === 'INPUT' && a.type === 'text') || a.tagName === 'TEXTAREA');
  // The on-screen keyboard only makes the page shorter; that must not flip the layout.
  if (typing && w === lastWidth) return;
  lastWidth = w;
  document.documentElement.dataset.layout = w >= 700 || w > h ? 'landscape' : 'portrait';
}

function setStep(step) {
  state.step = step;
  for (const name of ['songs', 'joins', 'finish']) $(`#view-${name}`).hidden = name !== step;
  for (const b of $$('.step')) {
    const on = b.dataset.step === step;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'step');
    else b.removeAttribute('aria-current');
  }
  $('main').scrollTop = 0;
  for (const col of $$(`#view-${step} .col`)) col.scrollTop = 0;
  if (step === 'finish') renderFinish();
}

// ------------------------------------------------------------------ step 1: songs

function songCard(t, i, n) {
  const st = trackState(t);
  const rec = store.fileRecord(t.fileId);
  const picture = rec?.thumb ? `<img src="${rec.thumb}" alt="">` : icon(rec && rec.meta?.hasVideo === false ? 'music' : 'film');
  let meta = '';
  if (t.duration) {
    const whole = t.start < 0.05 && t.end > t.duration - 0.05;
    meta = whole ? `Whole song · ${spoken(t.duration)}` : `From ${clock(t.start)} to ${clock(t.end)} · ${spoken(t.end - t.start)}`;
  }
  let status = '';
  if (st === 'busy') status = '<div class="song-status">Reading this file…</div>';
  else if (st === 'missing') status = '<div class="song-status err">This file is not on this phone.</div>';
  else if (rec?.meta?.missing === 'picture') status = '<div class="song-status">The picture cannot be read here. Sound only.</div>';
  else if (rec?.meta?.missing === 'sound' || rec?.meta?.missing === 'nosound') status = '<div class="song-status">This file has no sound.</div>';
  const main = st === 'missing'
    ? `<button type="button" class="btn primary small" data-act="again">${icon('folder')} Choose it again</button>`
    : `<button type="button" class="btn small" data-act="trim"${st === 'busy' ? ' disabled' : ''}>${icon('scissors')} Trim</button>`;
  return `
    <article class="song${st === 'missing' ? ' problem' : ''}" data-uid="${t.uid}">
      <button type="button" class="drag" data-act="drag" aria-label="Hold and drag to move this song">${icon('grip')}</button>
      <div class="thumb">${picture}<span class="song-num">${i + 1}</span></div>
      <div class="song-info">
        <div class="song-title">${esc(t.title)}</div>
        <div class="song-meta">${meta}</div>${status}
      </div>
      <div class="song-actions">
        ${main}
        <button type="button" class="icon-btn" data-act="up"${i === 0 ? ' disabled' : ''} aria-label="Move up">${icon('up')}</button>
        <button type="button" class="icon-btn" data-act="down"${i === n - 1 ? ' disabled' : ''} aria-label="Move down">${icon('down')}</button>
        <button type="button" class="icon-btn danger" data-act="remove" aria-label="Remove this song">${icon('trash')}</button>
      </div>
    </article>`;
}

function totalSeconds() {
  const list = tracks().filter((t) => t.duration);
  if (!list.length) return 0;
  return estimateSeconds(list.map((t) => clipSpec(t)), list.slice(0, -1).map((t) => joinOf(t)));
}

function renderSongs() {
  const list = tracks();
  const n = list.length;
  $('#songs-empty').hidden = n > 0;
  $('#tips').hidden = n > 0;
  $('#next-joins').hidden = n === 0;
  $('#song-list').innerHTML = list.map((t, i) => {
    const chip = i < n - 1
      ? `<button type="button" class="join-chip${t.join ? ' own' : ''}" data-join="${i}">${icon('join')}<span>${esc(describeJoin(joinOf(t), state.ownSounds))}</span><em>Change</em></button>`
      : '';
    return songCard(t, i, n) + chip;
  }).join('');
  $('#songs-summary').textContent = n ? `${n} song${n > 1 ? 's' : ''} · about ${spoken(totalSeconds())}` : '';
}

function moveTrack(from, to) {
  const list = tracks();
  if (to < 0 || to >= list.length) return;
  const [t] = list.splice(from, 1);
  list.splice(to, 0, t);
  touch();
  renderSongs();
  const card = $(`.song[data-uid="${t.uid}"]`);
  card?.classList.add('moved');
  card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function removeTrack(i) {
  const list = tracks();
  const [t] = list.splice(i, 1);
  touch();
  renderSongs();
  toast(`Removed "${t.title}"`, {
    action: 'Undo',
    onAction: () => {
      list.splice(Math.min(i, list.length), 0, t);
      touch();
      renderSongs();
    },
  });
}

function startDrag(e, card) {
  e.preventDefault();
  const list = $('#song-list');
  const scroller = document.documentElement.dataset.layout === 'landscape' ? card.closest('.col') : $('main');
  list.classList.add('sorting');
  card.classList.add('dragging');
  const move = (ev) => {
    const y = ev.clientY;
    const cards = $$('.song', list);
    const i = cards.indexOf(card);
    const prev = cards[i - 1];
    const next = cards[i + 1];
    if (prev) {
      const r = prev.getBoundingClientRect();
      if (y < r.top + r.height / 2) list.insertBefore(card, prev);
    }
    if (next) {
      const r = next.getBoundingClientRect();
      if (y > r.top + r.height / 2) list.insertBefore(card, next.nextSibling);
    }
    const box = scroller.getBoundingClientRect();
    if (y < box.top + 70) scroller.scrollTop -= 16;
    else if (y > box.bottom - 70) scroller.scrollTop += 16;
  };
  const end = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', end);
    window.removeEventListener('pointercancel', end);
    list.classList.remove('sorting');
    const order = $$('.song', list).map((c) => c.dataset.uid);
    const before = tracks().map((t) => t.uid).join();
    state.project.tracks = order.map((id) => tracks().find((t) => t.uid === id));
    if (before !== order.join()) touch();
    renderSongs();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

async function addFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  store.askToKeepStorage();
  const problems = [];
  let noRoom = false;
  for (const file of files) {
    if (tracks().length >= MAX_SONGS) {
      problems.push(`Only ${MAX_SONGS} songs fit in one fusion.`);
      break;
    }
    const t = {
      uid: uid(), fileId: '', title: titleFromFileName(file.name), fileName: file.name, fileSize: file.size,
      duration: 0, start: 0, end: 0, join: null, busy: true,
    };
    tracks().push(t);
    renderSongs();
    try {
      let rec = store.findSameFile(file);
      if (rec && !store.hasFile(rec.id)) rec = null;
      if (!rec) {
        const { meta, thumb } = await probe(file);
        rec = { id: uid(), name: file.name, size: file.size, type: file.type, lastModified: file.lastModified, meta, thumb };
        if (!(await store.saveFile(rec, file))) noRoom = true;
      }
      t.fileId = rec.id;
      t.duration = rec.meta.duration;
      t.end = rec.meta.duration;
      t.busy = false;
    } catch (err) {
      const i = tracks().indexOf(t);
      if (i >= 0) tracks().splice(i, 1);
      problems.push(`"${file.name}" ${err instanceof FileProblem ? err.message : 'could not be read'}.`);
    }
    touch();
    renderSongs();
  }
  renderFinish();
  if (problems.length) await tell('Some files could not be added', problems.join('\n'));
  else if (noRoom) toast('This phone is short of space. The songs will need to be chosen again next time.', { ms: 7000 });
}

/** Re-connects songs whose file is missing (after a backup was opened, or storage was cleared). */
async function relinkFiles(fileList) {
  const files = [...fileList];
  const target = tracks().find((t) => t.uid === state.againUid);
  state.againUid = null;
  let fixed = 0;
  const problems = [];
  for (const file of files) {
    const missing = tracks().filter((t) => trackState(t) === 'missing');
    let hit = missing.find((t) => t.fileName === file.name && (!t.fileSize || t.fileSize === file.size))
      || missing.find((t) => t.fileName === file.name);
    if (!hit && files.length === 1 && target && trackState(target) === 'missing') hit = target;
    if (!hit) continue;
    try {
      const { meta, thumb } = await probe(file);
      await store.saveFile({ id: hit.fileId, name: file.name, size: file.size, type: file.type, lastModified: file.lastModified, meta, thumb }, file);
      for (const t of tracks().filter((x) => x.fileId === hit.fileId)) {
        t.fileName = file.name;
        t.fileSize = file.size;
        t.duration = meta.duration;
        t.end = clamp(t.end || meta.duration, 1, meta.duration);
        t.start = clamp(t.start, 0, Math.max(0, t.end - 1));
      }
      fixed++;
    } catch (err) {
      problems.push(`"${file.name}" ${err instanceof FileProblem ? err.message : 'could not be read'}.`);
    }
  }
  touch();
  renderSongs();
  renderFinish();
  if (problems.length) await tell('Some files could not be used', problems.join('\n'));
  else if (!fixed) await tell('That is a different file', 'None of the chosen files has the same name as a missing song. Please look for the file with the name shown on the song.');
  else toast(fixed === 1 ? 'Song found' : `${fixed} songs found`);
}

async function openTrimFor(t) {
  let file = null;
  try { file = await store.getFile(t.fileId); } catch { /* shown inside the trim screen */ }
  state.trimUid = t.uid;
  showModal($('#modal-trim'), () => {
    const r = closeTrim();
    const track = tracks().find((x) => x.uid === state.trimUid);
    state.trimUid = null;
    if (!r || !track) return;
    track.title = r.title || track.title;
    track.end = clamp(r.end, 1, track.duration);
    track.start = clamp(r.start, 0, Math.max(0, track.end - 1));
    touch();
    renderSongs();
    renderFinish();
  });
  openTrim({
    title: t.title, file, duration: t.duration, start: t.start, end: t.end,
    soundOnly: store.fileRecord(t.fileId)?.meta?.hasVideo === false,
  });
}

// ------------------------------------------------------------------ step 2: joins

const soundHooks = {
  getOwnSounds: () => state.ownSounds,
  loadSound: (id) => store.getSoundBlob(id),
  async onAddSound(file) {
    if (file.size > 25 * 1024 * 1024) {
      await tell('That file is too big', 'Please choose a short sound, not a whole song.');
      return null;
    }
    try {
      await decodeSound(file, 48000);
    } catch {
      await tell('That file cannot be used', 'Please choose a sound file, for example an MP3.');
      return null;
    }
    const sound = { id: `own-${uid()}`, name: titleFromFileName(file.name).slice(0, 30) };
    try {
      await store.saveSound({ ...sound, blob: file });
    } catch {
      await tell('No room to keep that sound', 'This phone is short of storage space.');
      return null;
    }
    state.ownSounds.push(sound);
    return sound.id;
  },
  async onRemoveSound(id) {
    await store.deleteSound(id);
    forgetSound(id);
    state.ownSounds = state.ownSounds.filter((s) => s.id !== id);
    if (state.project.join.sound === id) state.project.join.sound = '';
    for (const t of tracks()) if (t.join?.sound === id) t.join.sound = '';
    touch();
  },
};

let allJoinsEditor = null;
let oneJoinEditor = null;

function mountEditors() {
  allJoinsEditor = mountJoinEditor({
    stylesEl: $('#joins-styles'), restEl: $('#joins-rest'),
    getJoin: () => state.project.join,
    onChange: (j) => { state.project.join = j; touch(); renderSongs(); },
    ...soundHooks,
  });
  oneJoinEditor = mountJoinEditor({
    stylesEl: $('#join-styles'), restEl: $('#join-rest'),
    getJoin: () => joinOf(tracks()[state.joinIndex]),
    onChange: (j) => { const t = tracks()[state.joinIndex]; if (t) { t.join = j; touch(); } },
    ...soundHooks,
  });
}

function openJoin(i) {
  const a = tracks()[i];
  const b = tracks()[i + 1];
  if (!a || !b) return;
  state.joinIndex = i;
  $('#join-title').textContent = `Join after song ${i + 1}`;
  $('#join-between').textContent = `From "${a.title}" to "${b.title}".`;
  oneJoinEditor.render();
  showModal($('#modal-join'), () => {
    state.joinIndex = -1;
    allJoinsEditor.render();
    renderSongs();
  });
}

function clearPreview() {
  state.preview?.controller.abort();
  if (state.preview?.url) URL.revokeObjectURL(state.preview.url);
  state.preview = null;
  $('#preview-player').innerHTML = '';
}

async function previewJoin() {
  const p = state.project;
  const a = tracks()[state.joinIndex];
  const b = tracks()[state.joinIndex + 1];
  if (!a || !b) return;
  if (state.busy) {
    toast('Please wait until the fusion has finished.');
    return;
  }
  if (state.problem) {
    await tell('Preview is not possible here', state.problem);
    return;
  }
  if (trackState(a) !== 'ready' || trackState(b) !== 'ready') {
    toast('Both songs must be on this phone to preview the join.');
    return;
  }
  const join = joinOf(a);
  const lead = (styleOf(join.style).timed ? join.duration : 0) + 5;
  let plan;
  try {
    plan = makePlan({
      kind: p.output.kind, preview: true,
      clips: [clipSpec(a, { start: Math.max(a.start, a.end - lead) }), clipSpec(b, { end: Math.min(b.end, b.start + lead) })],
      joins: [join],
      options: { showNext: p.showNext },
    });
  } catch (err) {
    await tell('Preview is not possible', err.message);
    return;
  }

  clearPreview();
  const controller = new AbortController();
  state.preview = { controller, url: null };
  $('#preview-wait').hidden = false;
  $('#preview-canvas').hidden = plan.kind !== 'video';
  $('#preview-bar').style.width = '0%';
  $('#preview-again').hidden = true;
  showModal($('#modal-preview'), clearPreview);
  try {
    const res = await renderFusion({
      plan, getFile: store.getFile, loadSound: soundHooks.loadSound, canvas: $('#preview-canvas'), fileName: 'preview',
      signal: controller.signal, onProgress: ({ fraction }) => { $('#preview-bar').style.width = `${Math.round(fraction * 100)}%`; },
    });
    if (controller.signal.aborted || state.preview?.controller !== controller) return;
    state.preview.url = URL.createObjectURL(res.file);
    $('#preview-wait').hidden = true;
    const tag = plan.kind === 'video' ? 'video' : 'audio';
    $('#preview-player').innerHTML = `<${tag} controls autoplay playsinline src="${state.preview.url}"></${tag}>`;
    $('#preview-again').hidden = false;
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.error(err);
    hideModal($('#modal-preview'));
    await tell('The preview could not be made', err instanceof FusionError ? err.message : 'Something went wrong. Please try again.');
  }
}

// ------------------------------------------------------------------ step 3: finish

function clearResult() {
  if (state.result) URL.revokeObjectURL(state.result.url);
  state.result = null;
  $('#result-player').innerHTML = '';
}

function showResult(file, info) {
  clearResult();
  state.result = { file, url: URL.createObjectURL(file), info };
  const tag = info.kind === 'video' ? 'video' : 'audio';
  $('#result-player').innerHTML = `<${tag} controls playsinline preload="metadata" src="${state.result.url}"></${tag}>`;
}

function roughTime(seconds) {
  if (seconds < 50) return 'less than a minute left';
  const m = Math.ceil(seconds / 60);
  return `about ${m} minute${m > 1 ? 's' : ''} left`;
}

function showProgress({ stage, fraction, secondsLeft }) {
  const pct = clamp(Math.floor(fraction * 100), 0, 100);
  $('#progress-stage').textContent = stage;
  $('#progress-bar').style.width = `${pct}%`;
  $('#progress-text').textContent = secondsLeft != null && secondsLeft > 4 ? `${pct}% done · ${roughTime(secondsLeft)}` : `${pct}% done`;
}

function renderFinish() {
  const p = state.project;
  const out = p.output;
  for (const b of $$('#kind-choices .choice')) {
    const on = b.dataset.kind === out.kind;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  }
  for (const b of $$('#quality-choices button')) {
    const on = b.dataset.quality === out.quality;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on);
  }
  $('#quality-field').hidden = out.kind !== 'video';
  $('#opt-balance').checked = out.balance;
  $('#opt-fadein').checked = out.fadeIn;
  $('#opt-fadeout').checked = out.fadeOut;
  $('#opt-shownext').checked = p.showNext;

  const n = tracks().length;
  const waiting = tracks().filter((t) => trackState(t) !== 'ready').length;
  const busy = !!state.busy;
  const stale = !!state.result && state.result.info.signature !== JSON.stringify(buildSpec());

  $('#make-summary').textContent = n ? `${n} song${n > 1 ? 's' : ''} · about ${spoken(totalSeconds())} long` : 'No songs yet.';
  const make = $('#btn-make');
  make.disabled = !n || waiting > 0 || !!state.problem;
  make.textContent = state.result && !stale ? 'Make it again' : 'Make my fusion';
  $('#make-hint').textContent = state.problem ? state.problem
    : !n ? 'Add your songs first, on step 1.'
      : waiting ? `${waiting} song${waiting > 1 ? 's need' : ' needs'} attention on step 1 first.`
        : 'This can take a few minutes. Keep the page open while it works.';

  $('#make-card').hidden = busy;
  $('#progress-card').hidden = !busy;
  $('#result-card').hidden = busy || !state.result;
  if (state.result) {
    const { info } = state.result;
    $('#result-stale').hidden = !stale;
    $('#result-info').textContent = `${info.kind === 'video' ? 'Video' : 'Sound only'} · ${spoken(info.seconds)} · ${megabytes(info.size)}`;
    const save = $('#btn-save');
    save.href = state.result.url;
    save.download = `${safeFileName(p.name)}.${info.ext}`;
    let canShare = false;
    try {
      canShare = !!navigator.canShare?.({ files: [new File([''], `a.${info.ext}`, { type: info.mime })] });
    } catch { /* sharing not offered */ }
    $('#btn-share').hidden = !canShare;
  }
}

async function keepAwake(on) {
  try {
    if (on) state.wakeLock = (await navigator.wakeLock?.request('screen')) || null;
    else {
      await state.wakeLock?.release();
      state.wakeLock = null;
    }
  } catch { /* the phone may refuse; the person is told to keep the screen on */ }
}

function otherFusionFiles() {
  const names = [];
  for (const { id } of store.listProjects()) {
    if (id === state.project.id) continue;
    const name = store.loadProject(id)?.lastExport?.fileName;
    if (name) names.push(name);
  }
  return names;
}

async function makeFusion() {
  if (state.busy) return;
  const p = state.project;
  const spec = buildSpec();
  let plan;
  try {
    plan = makePlan(spec);
  } catch (err) {
    await tell('Not ready yet', err.message);
    return;
  }
  // The earlier fusion (if any) is kept until the new one has really finished.
  $('#result-player').firstElementChild?.pause?.();
  const controller = new AbortController();
  state.busy = { controller };
  $('#render-canvas').hidden = plan.kind !== 'video';
  renderFinish();
  showProgress({ stage: 'Getting ready', fraction: 0 });
  $('#progress-card').scrollIntoView({ block: 'nearest' });
  await keepAwake(true);
  try {
    const res = await renderFusion({
      plan, getFile: store.getFile, loadSound: soundHooks.loadSound, title: p.name, canvas: $('#render-canvas'),
      fileName: `fusion-${p.id}-${Date.now().toString(36)}`, signal: controller.signal, onProgress: showProgress,
    });
    p.lastExport = {
      fileName: res.file.name, mime: res.mime, ext: res.ext, kind: plan.kind, seconds: res.seconds,
      size: res.file.size, signature: JSON.stringify(spec), at: Date.now(),
    };
    showResult(res.file, p.lastExport);
    touch();
    await deleteStoredFusions([...otherFusionFiles(), res.file.name]);
    try { navigator.vibrate?.(200); } catch { /* optional */ }
    toast('Your fusion is ready');
  } catch (err) {
    if (err?.name === 'AbortError') {
      toast('Stopped');
    } else {
      console.error(err);
      await tell('The fusion could not be made', err instanceof FusionError ? err.message
        : 'Something went wrong. Please try again. If it keeps happening, choose "Smaller file" under More choices, or use fewer songs.');
    }
    touch();
  } finally {
    state.busy = null;
    keepAwake(false);
    renderFinish();
    if (state.result) $('#result-card').scrollIntoView({ block: 'nearest' });
  }
}

async function shareResult() {
  const r = state.result;
  if (!r) return;
  try {
    const file = new File([r.file], `${safeFileName(state.project.name)}.${r.info.ext}`, { type: r.info.mime });
    await navigator.share({ files: [file], title: state.project.name });
  } catch (err) {
    if (err?.name !== 'AbortError') toast('Sharing did not work. Use "Save to this phone" instead.');
  }
}

// ------------------------------------------------------------------ my fusions

function when(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'today';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function renderMenu() {
  const list = store.listProjects();
  const cur = state.project.id;
  $('#project-list').innerHTML = list.length ? list.map((p) => `
    <div class="project-row${p.id === cur ? ' on' : ''}">
      <button type="button" class="project-open" data-open="${esc(p.id)}">
        <b>${esc(p.name)}</b>
        <span>${p.songs} song${p.songs === 1 ? '' : 's'} · ${p.id === cur ? 'open now' : when(p.updatedAt)}</span>
      </button>
      <button type="button" class="icon-btn danger" data-delete="${esc(p.id)}" aria-label="Delete ${esc(p.name)}">${icon('trash')}</button>
    </div>`).join('') : '<p class="empty">Nothing saved yet. Your fusion is saved by itself once you add a song.</p>';
}

async function setProject(raw) {
  const p = normalise(raw);
  state.project = p;
  store.setCurrentProjectId(p.id);
  clearResult();
  $('#project-name').value = p.name;
  showSaved(true);
  allJoinsEditor?.render();
  renderSongs();
  if (p.lastExport?.fileName) {
    const file = await openStoredFusion(p.lastExport.fileName, p.lastExport.mime);
    if (state.project !== p) return;
    if (file) showResult(file, p.lastExport);
    else p.lastExport = null;
  }
  renderFinish();
}

function unusedName() {
  const names = new Set(store.listProjects().map((p) => p.name));
  if (!names.has('My fusion')) return 'My fusion';
  for (let i = 2; ; i++) if (!names.has(`My fusion ${i}`)) return `My fusion ${i}`;
}

async function openProject(id) {
  if (state.busy) {
    toast('Please wait until the fusion has finished.');
    return;
  }
  saveSoon.now();
  const raw = store.loadProject(id);
  if (!raw) return;
  await setProject(raw);
  setStep('songs');
  hideModal($('#modal-menu'));
}

async function deleteProject(id) {
  const info = store.listProjects().find((p) => p.id === id);
  if (!info) return;
  if (id === state.project.id && state.busy) {
    toast('Please wait until the fusion has finished.');
    return;
  }
  const yes = await ask({ title: `Delete "${info.name}"?`, text: 'Its song list and its finished fusion will be removed from this page. Your original videos are not touched.', yes: 'Delete', danger: true });
  if (!yes) return;
  saveSoon.now();
  store.deleteProject(id);
  if (id === state.project.id) {
    const next = store.listProjects()[0];
    await setProject(next ? store.loadProject(next.id) : blankProject());
    setStep('songs');
  }
  await store.tidyFiles();
  const keep = otherFusionFiles();
  if (state.project.lastExport?.fileName) keep.push(state.project.lastExport.fileName);
  await deleteStoredFusions(keep);
  renderMenu();
}

function saveBackup() {
  const p = state.project;
  const files = {};
  for (const t of p.tracks) {
    const rec = store.fileRecord(t.fileId);
    if (rec) files[t.fileId] = { name: rec.name, size: rec.size, type: rec.type, lastModified: rec.lastModified, meta: rec.meta, thumb: rec.thumb };
  }
  const data = { app: 'fusion-maker', version: 1, project: { ...p, lastExport: null, tracks: p.tracks.map(({ busy, ...t }) => t) }, files };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeFileName(p.name)}.fusion.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  toast('Backup file saved');
}

async function openBackup(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
    if (data?.app !== 'fusion-maker' || !data.project) throw new Error('not a backup');
  } catch {
    await tell('That is not a Fusion Maker backup file');
    return;
  }
  saveSoon.now();
  for (const [id, rec] of Object.entries(data.files || {})) await store.saveFileStub({ ...rec, id });
  await setProject({ ...data.project, id: uid(), lastExport: null });
  touch();
  setStep('songs');
  hideModal($('#modal-menu'));
  if (tracks().some((t) => trackState(t) === 'missing')) {
    await tell('Backup opened', 'Some videos are not on this phone yet. Tap "Choose it again" on a song and pick the videos. You can pick several at once.');
  }
}

// ------------------------------------------------------------------ wiring

function wire() {
  window.addEventListener('resize', applyLayout);
  window.addEventListener('orientationchange', () => setTimeout(applyLayout, 150));
  document.addEventListener('focusout', () => setTimeout(applyLayout, 250));

  for (const b of $$('.step')) b.onclick = () => setStep(b.dataset.step);
  for (const b of $$('[data-goto]')) b.onclick = () => setStep(b.dataset.goto);

  for (const modal of $$('.modal')) {
    if (modal.id === 'modal-ask') continue;
    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]') || (e.target === modal && !modal.classList.contains('full'))) hideModal(modal);
    });
  }

  const name = $('#project-name');
  name.addEventListener('input', () => {
    state.project.name = name.value.trim().slice(0, 60) || 'My fusion';
    touch();
    renderFinish();
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
  name.addEventListener('blur', () => { name.value = state.project.name; });
  $('#trim-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });

  // songs
  $('#btn-pick').onclick = () => $('#pick-videos').click();
  $('#btn-pick-any').onclick = () => $('#pick-any').click();
  for (const id of ['#pick-videos', '#pick-any']) {
    $(id).addEventListener('change', (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      addFiles(files);
    });
  }
  $('#pick-again').addEventListener('change', (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    if (files.length) relinkFiles(files);
  });

  const list = $('#song-list');
  list.addEventListener('click', (e) => {
    const chip = e.target.closest('.join-chip');
    if (chip) {
      openJoin(Number(chip.dataset.join));
      return;
    }
    const btn = e.target.closest('[data-act]');
    const card = e.target.closest('.song');
    if (!btn || !card) return;
    const i = tracks().findIndex((t) => t.uid === card.dataset.uid);
    if (i < 0) return;
    const act = btn.dataset.act;
    if (act === 'trim') openTrimFor(tracks()[i]);
    else if (act === 'up') moveTrack(i, i - 1);
    else if (act === 'down') moveTrack(i, i + 1);
    else if (act === 'remove') removeTrack(i);
    else if (act === 'again') {
      state.againUid = tracks()[i].uid;
      $('#pick-again').click();
    }
  });
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.drag');
    if (handle && tracks().length > 1) startDrag(e, handle.closest('.song'));
  });

  // joins
  $('#opt-shownext').onchange = (e) => { state.project.showNext = e.target.checked; touch(); renderFinish(); };
  $('#join-reset').onclick = () => {
    const t = tracks()[state.joinIndex];
    if (t) { t.join = null; touch(); }
    hideModal($('#modal-join'));
  };
  $('#join-preview').onclick = previewJoin;
  $('#preview-again').onclick = () => {
    const player = $('#preview-player').firstElementChild;
    if (player) { player.currentTime = 0; player.play().catch(() => {}); }
  };

  // finish
  $('#kind-choices').onclick = (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b || state.busy) return;
    state.project.output.kind = b.dataset.kind;
    touch();
    renderFinish();
  };
  $('#quality-choices').onclick = (e) => {
    const b = e.target.closest('[data-quality]');
    if (!b || state.busy) return;
    state.project.output.quality = b.dataset.quality;
    touch();
    renderFinish();
  };
  for (const [id, key] of [['#opt-balance', 'balance'], ['#opt-fadein', 'fadeIn'], ['#opt-fadeout', 'fadeOut']]) {
    $(id).onchange = (e) => { state.project.output[key] = e.target.checked; touch(); renderFinish(); };
  }
  $('#btn-make').onclick = makeFusion;
  $('#btn-stop').onclick = async () => {
    if (await ask({ title: 'Stop making the fusion?', text: 'The work so far will be lost.', yes: 'Stop', no: 'Keep going', danger: true })) state.busy?.controller.abort();
  };
  $('#btn-share').onclick = shareResult;

  // my fusions + help
  $('#btn-menu').onclick = () => { renderMenu(); showModal($('#modal-menu')); };
  $('#btn-help').onclick = () => showModal($('#modal-help'));
  $('#project-list').onclick = (e) => {
    const open = e.target.closest('[data-open]');
    const del = e.target.closest('[data-delete]');
    if (open) openProject(open.dataset.open);
    else if (del) deleteProject(del.dataset.delete);
  };
  $('#btn-new').onclick = async () => {
    if (state.busy) {
      toast('Please wait until the fusion has finished.');
      return;
    }
    saveSoon.now();
    await setProject(blankProject(unusedName()));
    setStep('songs');
    hideModal($('#modal-menu'));
  };
  $('#btn-backup').onclick = saveBackup;
  $('#btn-restore').onclick = () => $('#pick-backup').click();
  $('#pick-backup').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) openBackup(file);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (state.busy) keepAwake(true);
    } else {
      saveSoon.now();
    }
  });
  window.addEventListener('pagehide', () => saveSoon.now());
  window.addEventListener('beforeunload', (e) => {
    if (state.busy) e.preventDefault();
  });
}

async function boot() {
  applyLayout();
  paintIcons();
  initTrim();
  wire();

  state.problem = browserProblem();
  if (state.problem) {
    $('#notice').textContent = state.problem;
    $('#notice').hidden = false;
  }

  await store.loadFileRecords();
  state.ownSounds = await store.listSounds();

  const saved = store.loadProject(store.currentProjectId() || '') || store.loadProject(store.listProjects()[0]?.id || '');
  state.project = normalise(saved || blankProject());
  mountEditors();
  await setProject(state.project);
  setStep('songs');

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    window.fusionDebug = { state, store, addFiles, makeFusion, setStep, openJoin, previewJoin };
  }
}

boot().catch((err) => {
  console.error(err);
  const n = $('#notice');
  n.textContent = 'This page could not start. Please close it and open it again.';
  n.hidden = false;
});
