// The "how do two songs join" chooser. Used on the Joins step (for every join) and in the
// box that opens when one particular join is tapped in the song list.
import { esc, icon } from './util.js';
import { SOUNDS, playSound } from './audio.js';

export const JOIN_STYLES = [
  { id: 'blend', name: 'Smooth blend', desc: 'One song melts into the next', timed: true },
  { id: 'dip', name: 'Fade out, fade in', desc: 'Goes dark and quiet, then the next begins', timed: true },
  { id: 'slide', name: 'Slide', desc: 'The next song pushes in from the side', timed: true },
  { id: 'wipe', name: 'Wipe', desc: 'The next song sweeps across', timed: true },
  { id: 'circle', name: 'Circle', desc: 'The next song opens from the middle', timed: true },
  { id: 'none', name: 'No effect', desc: 'The next song starts straight away', timed: false },
];

export const DEFAULT_JOIN = { style: 'blend', duration: 3, sound: '' };
const SECONDS = [1, 2, 3, 4, 5, 6];

const A = '#a78bfa';
const B = '#f59e0b';
const GLYPH = {
  blend: `<rect x="4" y="6" width="30" height="24" rx="4" fill="${A}"/><rect x="22" y="6" width="30" height="24" rx="4" fill="${B}" opacity=".78"/>`,
  dip: `<rect x="3" y="6" width="19" height="24" rx="4" fill="${A}"/><rect x="21" y="6" width="14" height="24" fill="#1f1a2e"/><rect x="34" y="6" width="19" height="24" rx="4" fill="${B}"/>`,
  slide: `<rect x="4" y="6" width="22" height="24" rx="4" fill="${A}"/><rect x="25" y="6" width="27" height="24" rx="4" fill="${B}"/><path d="M45 18H33m4-4-4 4 4 4" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`,
  wipe: `<rect x="4" y="6" width="48" height="24" rx="4" fill="${A}"/><path d="M4 10a4 4 0 0 1 4-4h20v24H8a4 4 0 0 1-4-4z" fill="${B}"/><path d="M28 3v30" stroke="#fff" stroke-width="2.4"/>`,
  circle: `<rect x="4" y="6" width="48" height="24" rx="4" fill="${A}"/><circle cx="28" cy="18" r="9" fill="${B}"/>`,
  none: `<rect x="4" y="6" width="23" height="24" rx="4" fill="${A}"/><rect x="29" y="6" width="23" height="24" rx="4" fill="${B}"/>`,
};

export const styleOf = (id) => JOIN_STYLES.find((s) => s.id === id) || JOIN_STYLES[0];

export function soundName(id, ownSounds = []) {
  return SOUNDS.find((s) => s.id === id)?.name || ownSounds.find((s) => s.id === id)?.name || '';
}

/** "Smooth blend · 3 sec · Whoosh sound" */
export function describeJoin(join, ownSounds = []) {
  const style = styleOf(join.style);
  const parts = [style.name];
  if (style.timed) parts.push(`${join.duration} sec`);
  const sound = join.sound && soundName(join.sound, ownSounds);
  if (sound) parts.push(`${sound} sound`);
  return parts.join(' · ');
}

/**
 * Draws the chooser into two containers (so the two halves can sit side by side in
 * landscape) and keeps it up to date.
 *
 * options = { stylesEl, restEl, getJoin, onChange(join), getOwnSounds, loadSound, onAddSound(file), onRemoveSound(id) }
 */
export function mountJoinEditor(options) {
  const { stylesEl, restEl, getJoin, onChange, getOwnSounds, loadSound, onAddSound, onRemoveSound } = options;

  function render() {
    const join = getJoin();
    const style = styleOf(join.style);
    stylesEl.innerHTML = `<div class="choice-grid">${JOIN_STYLES.map((s) => `
      <button type="button" class="choice${s.id === join.style ? ' on' : ''}" data-style="${s.id}" aria-pressed="${s.id === join.style}">
        <svg class="glyph" viewBox="0 0 56 36" aria-hidden="true">${GLYPH[s.id]}</svg>
        <b>${s.name}</b><span>${s.desc}</span>
      </button>`).join('')}</div>`;

    const rows = [{ id: '', name: 'No sound' }, ...SOUNDS, ...getOwnSounds().map((s) => ({ ...s, own: true }))];
    restEl.innerHTML = `
      <div class="field"${style.timed ? '' : ' hidden'}>
        <h3>How long should the change take?</h3>
        <div class="seg" role="group">${SECONDS.map((n) => `
          <button type="button" class="${n === join.duration ? 'on' : ''}" data-seconds="${n}" aria-pressed="${n === join.duration}">${n}<small> sec</small></button>`).join('')}
        </div>
      </div>
      <div class="field">
        <h3>Play a sound at the change?</h3>
        <div class="sound-list">${rows.map((s) => `
          <div class="sound-row${s.id === join.sound ? ' on' : ''}">
            <button type="button" class="sound-pick" data-sound="${esc(s.id)}" aria-pressed="${s.id === join.sound}"><i class="dot"></i>${esc(s.name)}</button>
            ${s.id ? `<button type="button" class="icon-btn" data-listen="${esc(s.id)}" aria-label="Listen to ${esc(s.name)}">${icon('speaker')}</button>` : ''}
            ${s.own ? `<button type="button" class="icon-btn danger" data-remove="${esc(s.id)}" aria-label="Remove ${esc(s.name)}">${icon('trash')}</button>` : ''}
          </div>`).join('')}
        </div>
        <button type="button" class="link-btn" data-add-sound>${icon('plus')} Use a sound file from this phone</button>
        <input type="file" accept="audio/*" hidden>
      </div>`;
  }

  stylesEl.onclick = (e) => {
    const btn = e.target.closest('[data-style]');
    if (!btn) return;
    onChange({ ...getJoin(), style: btn.dataset.style });
    render();
  };

  restEl.onclick = async (e) => {
    const join = getJoin();
    const seconds = e.target.closest('[data-seconds]');
    const pick = e.target.closest('[data-sound]');
    const listen = e.target.closest('[data-listen]');
    const remove = e.target.closest('[data-remove]');
    if (seconds) {
      onChange({ ...join, duration: Number(seconds.dataset.seconds) });
      render();
    } else if (pick) {
      onChange({ ...join, sound: pick.dataset.sound });
      render();
      if (pick.dataset.sound) playSound(pick.dataset.sound, loadSound).catch(() => {});
    } else if (listen) {
      playSound(listen.dataset.listen, loadSound).catch(() => {});
    } else if (remove) {
      await onRemoveSound(remove.dataset.remove);
      render();
    } else if (e.target.closest('[data-add-sound]')) {
      restEl.querySelector('input[type=file]').click();
    }
  };

  restEl.onchange = async (e) => {
    if (e.target.type !== 'file' || !e.target.files[0]) return;
    const id = await onAddSound(e.target.files[0]);
    if (id) onChange({ ...getJoin(), sound: id });
    render();
  };

  render();
  return { render };
}
