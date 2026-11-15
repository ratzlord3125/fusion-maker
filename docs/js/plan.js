// Works out the exact timeline of a fusion. No browser features are used here.
//
// Everything is measured in whole video frames (30 per second), and the sound uses a whole
// number of samples per frame, so picture and sound cannot drift apart however many songs
// are joined.

export const FPS = 30;
export const MAX_SONGS = 40;

/** How each join style behaves. `overlap` styles play both songs at once for a moment. */
export const STYLES = {
  none: { kind: 'cut' },
  blend: { kind: 'overlap', effect: 'blend' },
  slide: { kind: 'overlap', effect: 'slide' },
  wipe: { kind: 'overlap', effect: 'wipe' },
  circle: { kind: 'overlap', effect: 'circle' },
  dip: { kind: 'dip' }, // fade out completely, then fade in
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export const SIZES = { 720: [1280, 720], 480: [848, 480], preview: [640, 360] };

/**
 * spec = {
 *   kind: 'video' | 'audio', quality: '720' | '480', preview: boolean,
 *   clips: [{ fileId, start, end, duration, title }],
 *   joins: [{ style, duration, sound }]            (one fewer than clips)
 *   options: { showNext, balance, fadeIn, fadeOut }
 * }
 * All returned positions are frame numbers on the finished timeline.
 */
export function makePlan(spec) {
  const preview = !!spec.preview;
  const kind = spec.kind === 'audio' ? 'audio' : 'video';
  const options = spec.options || {};
  if (!Array.isArray(spec.clips) || !spec.clips.length) throw new Error('Add at least one song first.');

  const dims = kind !== 'video' ? null : preview ? SIZES.preview : SIZES[spec.quality] || SIZES[720];

  const clips = spec.clips.map((c) => {
    const length = Math.max(1, Number(c.duration) || 0);
    const start = clamp(Number(c.start) || 0, 0, Math.max(0, length - 1));
    const end = clamp(Number(c.end) || length, start + 1, Math.max(start + 1, length));
    return {
      fileId: c.fileId,
      title: String(c.title || ''),
      audioRate: Number(c.audioRate) || 0,
      start,
      frames: Math.max(FPS, Math.round((end - start) * FPS)),
      gain: 1,
      fadeIn: 0, // frames of fade from black/silence at the start (dip joins only)
      fadeOut: 0,
      abs: 0, // where this clip starts on the finished timeline
    };
  });

  const joins = [];
  for (let i = 0; i < clips.length - 1; i++) {
    const j = (Array.isArray(spec.joins) && spec.joins[i]) || {};
    const style = STYLES[j.style] || STYLES.none;
    // A join may use at most (just under) half of either neighbour, so two joins never collide.
    const room = Math.floor(Math.min(clips[i].frames, clips[i + 1].frames) / 2) - 1;
    const wanted = Math.round(clamp(Number(j.duration) || 0, 0, 12) * FPS);
    let kindJ = style.kind;
    let frames = 0;
    if (kindJ === 'overlap') frames = Math.min(wanted, room);
    if (kindJ === 'dip') frames = Math.min(Math.round(wanted / 2), room); // frames per half
    if (kindJ !== 'cut' && frames < 3) { kindJ = 'cut'; frames = 0; }
    joins.push({ kind: kindJ, effect: style.effect || '', frames, sound: typeof j.sound === 'string' ? j.sound : '' });
  }

  let acc = clips[0].frames;
  joins.forEach((j, i) => {
    const next = clips[i + 1];
    if (j.kind === 'overlap') {
      j.from = acc - j.frames;
      j.to = acc;
      j.mid = acc - j.frames / 2;
      next.abs = j.from;
      acc += next.frames - j.frames;
    } else {
      const half = j.kind === 'dip' ? j.frames : 0;
      j.from = acc - half;
      j.to = acc + half;
      j.mid = acc;
      next.abs = acc;
      if (half) { clips[i].fadeOut = half; next.fadeIn = half; }
      acc += next.frames;
    }
  });
  const total = acc;

  // "Up next" banners: on screen for about 4 seconds before a join, and through it.
  const banners = [];
  if (kind === 'video' && options.showNext !== false) {
    joins.forEach((j, i) => {
      const earliest = Math.max(clips[i].abs + 15, i > 0 ? joins[i - 1].to + 10 : 0);
      const start = Math.max(j.from - 4 * FPS, earliest);
      const end = j.kind === 'cut' ? j.from : j.to;
      if (end - start >= 1.5 * FPS) banners.push({ join: i, start, frames: end - start, title: clips[i + 1].title });
    });
  }

  const softStart = options.fadeIn !== false && !preview ? Math.min(Math.round(0.6 * FPS), Math.floor(total / 4)) : 0;
  const softEnd = options.fadeOut !== false && !preview ? Math.min(Math.round(2.5 * FPS), Math.floor(total / 4)) : 0;

  return {
    kind, preview, dims, clips, joins, total, banners, softStart, softEnd,
    balance: options.balance !== false && !preview && clips.length > 1,
  };
}

/** Length of the finished fusion in seconds, without building a full plan. */
export function estimateSeconds(clips, joins) {
  try {
    return makePlan({ kind: 'audio', clips, joins, options: {} }).total / FPS;
  } catch {
    return 0;
  }
}
