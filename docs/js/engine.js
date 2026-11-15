// Makes the finished fusion entirely inside the browser.
//
// Picture: every output frame is drawn on a canvas (one or two songs, the join effect, the
// "Up next" name) and handed to the phone's own video encoder.
// Sound:   the trimmed parts are mixed a second at a time, so memory use stays small.
import * as MB from 'mediabunny';
import { FPS } from './plan.js';
import { ClipAudioReader, Limiter, getSound, measureLoudness } from './audio.js';

const HALF_PI = Math.PI / 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** An error whose message is written for the person using the site. */
export class FusionError extends Error {}

/** Lets the page redraw (progress bar, Cancel button) without the slowdown timers get in hidden tabs. */
const breathe = (() => {
  if (globalThis.scheduler?.yield) return () => globalThis.scheduler.yield();
  const channel = new MessageChannel();
  let waiting = [];
  channel.port1.onmessage = () => {
    const run = waiting;
    waiting = [];
    run.forEach((resolve) => resolve());
  };
  return () => new Promise((resolve) => {
    waiting.push(resolve);
    channel.port2.postMessage(0);
  });
})();

export function browserProblem() {
  if (!window.isSecureContext) return 'This page must be opened with https:// to work.';
  if (!('VideoDecoder' in window) || !('VideoEncoder' in window) || !('AudioDecoder' in window)) {
    return 'This browser cannot make fusions. Please open this page in Chrome on an Android phone, or in Safari on an iPhone with a recent iOS (26 or newer).';
  }
  return '';
}

// ------------------------------------------------------------------ output setup

async function chooseFormat(plan, rate) {
  if (plan.kind === 'audio') {
    if (!(await MB.canEncodeAudio('mp3', { numberOfChannels: 2, sampleRate: rate }))) {
      const { registerMp3Encoder } = await import('../vendor/mediabunny-mp3-encoder.min.mjs');
      registerMp3Encoder();
    }
    return { format: new MB.Mp3OutputFormat(), audioCodec: 'mp3', audioBitrate: 192_000, ext: 'mp3', mime: 'audio/mpeg' };
  }

  const [width, height] = plan.dims;
  const bitrate = plan.preview ? 1_000_000 : height >= 720 ? 3_200_000 : 1_700_000;
  if (await MB.canEncodeVideo('avc', { width, height, bitrate })) {
    // MP4 with H.264 picture and AAC sound plays on every phone, TV and chat app.
    if (!(await MB.canEncodeAudio('aac', { numberOfChannels: 2, sampleRate: rate }))) {
      const { registerAacEncoder } = await import('../vendor/mediabunny-aac-encoder.min.mjs');
      registerAacEncoder();
    }
    return {
      format: new MB.Mp4OutputFormat({ fastStart: false }),
      videoCodec: 'avc', videoBitrate: bitrate, audioCodec: 'aac', audioBitrate: 160_000, ext: 'mp4', mime: 'video/mp4',
    };
  }
  const videoCodec = await MB.getFirstEncodableVideoCodec(['vp9', 'vp8'], { width, height, bitrate });
  if (videoCodec && (await MB.canEncodeAudio('opus', { numberOfChannels: 2, sampleRate: 48000 }))) {
    return {
      format: new MB.WebMOutputFormat(),
      videoCodec, videoBitrate: bitrate, audioCodec: 'opus', audioBitrate: 128_000, ext: 'webm', mime: 'video/webm', forceRate: 48000,
    };
  }
  throw new FusionError('This browser cannot make videos. You can still choose "Sound only", or open this page in Chrome.');
}

/** Big files are written straight to the phone's storage instead of being held in memory. */
async function openTarget(fileName, mime, small) {
  if (!small) {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('fusions', { create: true });
      const handle = await dir.getFileHandle(fileName, { create: true });
      if (typeof handle.createWritable === 'function') {
        const writable = await handle.createWritable();
        return {
          target: new MB.StreamTarget(writable, { chunked: true, chunkSize: 4 * 1024 * 1024 }),
          async finish() {
            const file = await handle.getFile();
            return new File([file], fileName, { type: mime });
          },
          async discard() {
            try { await writable.abort(); } catch { /* already closed */ }
            try { await dir.removeEntry(fileName); } catch { /* nothing to remove */ }
          },
        };
      }
    } catch (err) {
      console.warn('Phone storage is not available for the fusion, using memory instead.', err);
    }
  }
  const target = new MB.BufferTarget();
  return {
    target,
    finish: async () => new File([target.buffer], fileName, { type: mime }),
    discard: async () => {},
  };
}

/** Removes fusions that were written to the phone's storage earlier (keeps `keep`). */
export async function deleteStoredFusions(keep = []) {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('fusions', { create: true });
    for await (const name of dir.keys()) if (!keep.includes(name)) await dir.removeEntry(name).catch(() => {});
  } catch { /* storage not available */ }
}

/** Opens a fusion written earlier, or null. */
export async function openStoredFusion(fileName, mime) {
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('fusions');
    const file = await (await dir.getFileHandle(fileName)).getFile();
    return file.size > 0 ? new File([file], fileName, { type: mime }) : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ picture

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans", "Noto Sans Devanagari", Arial, sans-serif';

function fitText(g, text, maxWidth, size, minSize, weight = 700) {
  let s = size;
  g.font = `${weight} ${s}px ${FONT}`;
  while (g.measureText(text).width > maxWidth && s > minSize) {
    s -= 2;
    g.font = `${weight} ${s}px ${FONT}`;
  }
  if (g.measureText(text).width > maxWidth) {
    const chars = [...text];
    while (chars.length > 3 && g.measureText(`${chars.join('')}…`).width > maxWidth) chars.pop();
    text = `${chars.join('').trimEnd()}…`;
  }
  return text;
}

/** The "UP NEXT  Song name" pill, drawn once per join. Canvas text copes with any language. */
export function makeBanner(title, W) {
  const k = W / 1280;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = Math.round(104 * k);
  const g = canvas.getContext('2d');
  const label = 'UP NEXT';
  g.font = `800 ${Math.round(24 * k)}px ${FONT}`;
  const labelW = g.measureText(label).width;
  const padX = 34 * k;
  const gap = 20 * k;
  const text = fitText(g, title.trim() || 'Next song', W - 110 * k - labelW - gap - padX * 2, Math.round(44 * k), Math.round(28 * k));
  const textFont = g.font;
  const textW = g.measureText(text).width;
  const pillW = padX * 2 + labelW + gap + textW;
  const pillH = 80 * k;
  const x = (W - pillW) / 2;
  const y = (canvas.height - pillH) / 2;
  roundRect(g, x, y, pillW, pillH, pillH / 2);
  g.fillStyle = 'rgba(20, 12, 44, 0.84)';
  g.fill();
  g.lineWidth = Math.max(1, 2 * k);
  g.strokeStyle = 'rgba(255, 255, 255, 0.4)';
  g.stroke();
  g.textBaseline = 'middle';
  g.font = `800 ${Math.round(24 * k)}px ${FONT}`;
  g.fillStyle = '#ffcc4d';
  g.fillText(label, x + padX, canvas.height / 2 + 1);
  g.font = textFont;
  g.fillStyle = '#ffffff';
  g.fillText(text, x + padX + labelW + gap, canvas.height / 2 + 1);
  return canvas;
}

/** Shown instead of a picture when a song file has sound only. */
function makeTitleCard(title, W, H) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#2b1a5e');
  bg.addColorStop(1, '#0f0a24');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = '#ffcc4d';
  g.font = `${Math.round(H * 0.2)}px ${FONT}`;
  g.fillText('♪', W / 2, H * 0.36);
  g.fillStyle = '#ffffff';
  const text = fitText(g, title.trim() || 'Song', W * 0.84, Math.round(H * 0.085), Math.round(H * 0.05));
  g.fillText(text, W / 2, H * 0.6);
  return canvas;
}

/** Reads the frames of one trimmed clip, in order. */
class ClipPicture {
  constructor(clip, file, W, H) {
    this.clip = clip;
    this.file = file;
    this.W = W;
    this.H = H;
    this.sample = null;
    this.card = null;
  }

  async open() {
    try {
      this.input = new MB.Input({ source: new MB.BlobSource(this.file), formats: MB.ALL_FORMATS });
      const track = await this.input.getPrimaryVideoTrack();
      if (track && (await track.canDecode())) {
        const { start, frames } = this.clip;
        const times = (function* frameTimes() {
          // the middle of each output frame, so a 30-per-second source maps one to one
          for (let k = 0; k < frames; k++) yield start + (k + 0.5) / FPS;
        })();
        this.iter = new MB.VideoSampleSink(track).samplesAtTimestamps(times);
      }
    } catch (err) {
      console.warn('Could not open the picture of', this.clip.title, err);
    }
    if (!this.iter) this.card = makeTitleCard(this.clip.title, this.W, this.H);
    return this;
  }

  async advance() {
    if (!this.iter) return;
    const next = await this.iter.next();
    if (!next.done && next.value && next.value !== this.sample) {
      this.sample?.close();
      this.sample = next.value;
    }
  }

  /** Fills the whole frame: the picture scaled to fit, black bars where needed. */
  draw(g) {
    const { W, H } = this;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    if (this.card) {
      g.drawImage(this.card, 0, 0);
      return;
    }
    const s = this.sample;
    if (!s) return;
    const scale = Math.min(W / s.displayWidth, H / s.displayHeight);
    const w = Math.round(s.displayWidth * scale);
    const h = Math.round(s.displayHeight * scale);
    s.draw(g, Math.round((W - w) / 2), Math.round((H - h) / 2), w, h);
  }

  close() {
    try { this.sample?.close(); } catch { /* already closed */ }
    try { this.iter?.return?.(); } catch { /* already finished */ }
    try { this.input?.dispose(); } catch { /* already closed */ }
    this.sample = null;
    this.iter = null;
  }
}

class Compositor {
  constructor(plan, canvas, getFile) {
    this.plan = plan;
    [this.W, this.H] = plan.dims;
    canvas.width = this.W;
    canvas.height = this.H;
    this.canvas = canvas;
    this.g = canvas.getContext('2d', { alpha: false });
    this.getFile = getFile;
    this.pics = new Map();
    this.first = 0;
    this.layer = null;
    this.banners = plan.banners.map((b) => ({ ...b, image: makeBanner(b.title, this.W) }));
  }

  async pic(i) {
    let p = this.pics.get(i);
    if (!p) {
      const clip = this.plan.clips[i];
      p = await new ClipPicture(clip, await this.getFile(clip.fileId), this.W, this.H).open();
      this.pics.set(i, p);
    }
    return p;
  }

  shade(amount) {
    const g = this.g;
    g.globalAlpha = clamp(amount, 0, 1);
    g.fillStyle = '#000';
    g.fillRect(0, 0, this.W, this.H);
    g.globalAlpha = 1;
  }

  async frame(f) {
    const { plan, g, W, H } = this;
    const clips = plan.clips;
    while (this.first < clips.length - 1 && f >= clips[this.first].abs + clips[this.first].frames) {
      this.pics.get(this.first)?.close();
      this.pics.delete(this.first);
      this.first++;
    }
    const i = this.first;
    const clip = clips[i];
    const A = await this.pic(i);
    await A.advance();

    if (i + 1 < clips.length && f >= clips[i + 1].abs) {
      // Two songs at once: the join effect.
      const B = await this.pic(i + 1);
      await B.advance();
      const join = plan.joins[i];
      const p = clamp((f - join.from + 0.5) / join.frames, 0, 1);
      const ease = p * p * (3 - 2 * p);
      if (!this.layer) {
        this.layer = document.createElement('canvas');
        this.layer.width = W;
        this.layer.height = H;
        this.layerG = this.layer.getContext('2d', { alpha: false });
      }
      B.draw(this.layerG);
      if (join.effect === 'slide') {
        const shift = Math.round(ease * W);
        A.draw(g);
        g.drawImage(this.canvas, -shift, 0); // move what was just drawn to the left
        g.drawImage(this.layer, W - shift, 0);
      } else if (join.effect === 'wipe') {
        A.draw(g);
        const w = Math.round(ease * W);
        if (w > 0) g.drawImage(this.layer, 0, 0, w, H, 0, 0, w, H);
      } else if (join.effect === 'circle') {
        A.draw(g);
        g.save();
        g.beginPath();
        g.arc(W / 2, H / 2, (ease * Math.hypot(W, H)) / 2 + 1, 0, Math.PI * 2);
        g.clip();
        g.drawImage(this.layer, 0, 0);
        g.restore();
      } else {
        A.draw(g);
        g.globalAlpha = p;
        g.drawImage(this.layer, 0, 0);
        g.globalAlpha = 1;
      }
    } else {
      A.draw(g);
      const k = f - clip.abs;
      if (k < clip.fadeIn) this.shade(1 - (k + 0.5) / clip.fadeIn);
      else if (k >= clip.frames - clip.fadeOut) this.shade((k - (clip.frames - clip.fadeOut) + 0.5) / clip.fadeOut);
    }

    for (const b of this.banners) {
      if (f < b.start || f >= b.start + b.frames) continue;
      const fade = Math.min(12, b.frames / 4);
      g.globalAlpha = clamp(Math.min((f - b.start + 1) / fade, (b.start + b.frames - f) / fade), 0, 1);
      g.drawImage(b.image, 0, Math.round(H * 0.04));
      g.globalAlpha = 1;
    }

    if (f < plan.softStart) this.shade(1 - (f + 0.5) / plan.softStart);
    else if (f >= plan.total - plan.softEnd) this.shade((f - (plan.total - plan.softEnd) + 0.5) / plan.softEnd);
  }

  close() {
    for (const p of this.pics.values()) p.close();
    this.pics.clear();
  }
}

// ------------------------------------------------------------------ sound

class Mixer {
  constructor(plan, rate, getFile, sounds) {
    this.plan = plan;
    this.rate = rate;
    this.spf = rate / FPS; // samples per video frame (always a whole number)
    this.getFile = getFile;
    this.sounds = sounds; // [{ L, R, start }]
    this.readers = new Map();
    this.first = 0;
    this.pos = 0;
    this.limiter = new Limiter(rate);
  }

  async reader(i) {
    let r = this.readers.get(i);
    if (!r) {
      const clip = this.plan.clips[i];
      r = await new ClipAudioReader(await this.getFile(clip.fileId), clip.start, clip.frames / FPS, this.rate).open();
      this.readers.set(i, r);
    }
    return r;
  }

  closeReader(i) {
    this.readers.get(i)?.close();
    this.readers.delete(i);
  }

  /** The next n samples of the finished mix. */
  async next(n) {
    const { plan, spf } = this;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    const p0 = this.pos;
    const p1 = p0 + n;

    for (let i = this.first; i < plan.clips.length; i++) {
      const clip = plan.clips[i];
      const c0 = clip.abs * spf;
      const len = clip.frames * spf;
      if (c0 >= p1) break;
      if (c0 + len <= p0) {
        this.closeReader(i);
        if (i === this.first) this.first++;
        continue;
      }
      const a = Math.max(p0, c0);
      const b = Math.min(p1, c0 + len);
      const part = await (await this.reader(i)).read(b - a);

      // Volume shape of this clip: its level, and the fades where it meets its neighbours.
      const before = plan.joins[i - 1];
      const after = plan.joins[i];
      const inN = before && before.kind !== 'cut' ? before.frames * spf : 0;
      const outN = after && after.kind !== 'cut' ? after.frames * spf : 0;
      const inCurve = before?.kind === 'overlap';
      const outCurve = after?.kind === 'overlap';
      const s0 = a - c0;
      const off = a - p0;
      for (let k = 0; k < b - a; k++) {
        const s = s0 + k;
        let gain = clip.gain;
        if (s < inN) {
          const x = (s + 0.5) / inN;
          gain *= inCurve ? Math.sin(x * HALF_PI) : x;
        }
        if (s >= len - outN) {
          const x = (s - (len - outN) + 0.5) / outN;
          gain *= outCurve ? Math.cos(x * HALF_PI) : 1 - x;
        }
        L[off + k] += part.L[k] * gain;
        R[off + k] += part.R[k] * gain;
      }
      if (b === c0 + len) this.closeReader(i);
    }

    for (const s of this.sounds) {
      const a = Math.max(p0, s.start);
      const b = Math.min(p1, s.start + s.L.length);
      for (let k = a; k < b; k++) {
        L[k - p0] += s.L[k - s.start] * 0.85;
        R[k - p0] += s.R[k - s.start] * 0.85;
      }
    }

    const inEnd = plan.softStart * spf;
    const outStart = (plan.total - plan.softEnd) * spf;
    const outLen = plan.softEnd * spf;
    if (p0 < inEnd || p1 > outStart) {
      for (let k = 0; k < n; k++) {
        const s = p0 + k;
        let gain = 1;
        if (s < inEnd) gain = (s + 0.5) / inEnd;
        else if (s >= outStart && outLen) gain = 1 - (s - outStart + 0.5) / outLen;
        L[k] *= gain;
        R[k] *= gain;
      }
    }

    this.limiter.process(L, R);
    this.pos = p1;
    return { L, R };
  }

  close() {
    for (const r of this.readers.values()) r.close();
    this.readers.clear();
  }
}

function pickRate(plan, forced) {
  if (forced) return forced;
  const votes = { 44100: 0, 48000: 0 };
  for (const c of plan.clips) votes[c.audioRate === 44100 ? 44100 : 48000] += c.frames;
  return votes[44100] > votes[48000] ? 44100 : 48000;
}

/** Makes quiet and loud songs sit at the same level. */
async function balanceLoudness(plan, getFile, report, signal) {
  const levels = [];
  for (let i = 0; i < plan.clips.length; i++) {
    if (signal?.aborted) return;
    const clip = plan.clips[i];
    report(i / plan.clips.length);
    try {
      levels.push(await measureLoudness(await getFile(clip.fileId), clip.start, clip.frames / FPS, signal));
    } catch (err) {
      console.warn('Could not measure', clip.title, err);
      levels.push(null);
    }
  }
  const known = levels.filter((v) => v !== null).sort((a, b) => a - b);
  if (known.length < 2) return;
  const target = clamp(known[Math.floor(known.length / 2)], -18, -14);
  plan.clips.forEach((clip, i) => {
    if (levels[i] !== null) clip.gain = Math.pow(10, clamp(target - levels[i], -12, 12) / 20);
  });
}

// ------------------------------------------------------------------ the whole job

/**
 * options = {
 *   plan         from makePlan()
 *   getFile      async (fileId) => File/Blob of that song
 *   loadSound    async (soundId) => Blob of a sound the person added (or null)
 *   title        name stored inside the file
 *   canvas       a <canvas> to draw on (shown to the person as a live preview)
 *   fileName     name without extension
 *   onProgress   ({ stage, fraction, secondsLeft }) => void
 *   signal       AbortSignal for the Cancel button
 * }
 * Resolves with { file, ext, mime, seconds }.
 */
export async function renderFusion({ plan, getFile, loadSound, title = '', canvas, fileName = 'fusion', onProgress = () => {}, signal }) {
  const aborted = () => {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  };
  let output = null;
  let store = null;
  let compositor = null;
  let mixer = null;

  try {
    const setup = await chooseFormat(plan, pickRate(plan));
    const rate = pickRate(plan, setup.forceRate);
    const spf = rate / FPS;

    if (plan.balance) {
      onProgress({ stage: 'Listening to each song', fraction: 0 });
      await balanceLoudness(plan, getFile, (x) => onProgress({ stage: 'Listening to each song', fraction: x * 0.06 }), signal);
      aborted();
    }
    const base = plan.balance ? 0.06 : 0;

    const sounds = [];
    for (const join of plan.joins) {
      if (!join.sound) continue;
      const sound = await getSound(join.sound, rate, loadSound).catch(() => null);
      if (sound) sounds.push({ L: sound.L, R: sound.R, start: Math.max(0, Math.round((join.mid / FPS - sound.anchor) * rate)) });
    }

    store = await openTarget(`${fileName}.${setup.ext}`, setup.mime, plan.preview);
    output = new MB.Output({ format: setup.format, target: store.target });

    let picture = null;
    if (plan.kind === 'video') {
      compositor = new Compositor(plan, canvas, getFile);
      picture = new MB.CanvasSource(canvas, { codec: setup.videoCodec, bitrate: setup.videoBitrate, keyFrameInterval: 2 });
      output.addVideoTrack(picture, { frameRate: FPS });
    }
    const sound = new MB.AudioSampleSource({ codec: setup.audioCodec, bitrate: setup.audioBitrate });
    output.addAudioTrack(sound);
    if (title) output.setMetadataTags({ title });
    await output.start();

    mixer = new Mixer(plan, rate, getFile, sounds);
    const addSound = async (samples) => {
      const { L, R } = await mixer.next(samples);
      const data = new Float32Array(samples * 2);
      data.set(L, 0);
      data.set(R, samples);
      const sample = new MB.AudioSample({ data, format: 'f32-planar', numberOfChannels: 2, sampleRate: rate, timestamp: (mixer.pos - samples) / rate });
      try {
        await sound.add(sample);
      } finally {
        sample.close();
      }
    };

    const began = performance.now();
    let lastPause = began;
    const stage = plan.kind === 'video' ? 'Making the video' : 'Joining the songs';
    const report = (done) => {
      const x = done / plan.total;
      const spent = (performance.now() - began) / 1000;
      onProgress({ stage, fraction: base + (1 - base) * x, secondsLeft: x > 0.03 && spent > 3 ? (spent / x) * (1 - x) : null });
    };

    if (plan.kind === 'video') {
      for (let f = 0; f < plan.total; f++) {
        aborted();
        try {
          await compositor.frame(f);
        } catch (err) {
          if (err instanceof FusionError) throw err;
          console.error(err);
          const which = plan.clips[compositor.first]?.title || 'one of the songs';
          throw new FusionError(`The picture of "${which}" could not be read. Try that file in a different format, or leave it out.`);
        }
        await picture.add(f / FPS, 1 / FPS);
        if ((f + 1) % FPS === 0 || f === plan.total - 1) {
          await addSound((f + 1) * spf - mixer.pos);
          report(f + 1);
        }
        if (performance.now() - lastPause > 40) {
          await breathe();
          lastPause = performance.now();
        }
      }
    } else {
      const totalSamples = plan.total * spf;
      while (mixer.pos < totalSamples) {
        aborted();
        await addSound(Math.min(rate, totalSamples - mixer.pos));
        report(mixer.pos / spf);
        await breathe();
      }
    }

    onProgress({ stage: 'Finishing', fraction: 1, secondsLeft: null });
    await output.finalize();
    const file = await store.finish();
    return { file, ext: setup.ext, mime: setup.mime, seconds: plan.total / FPS };
  } catch (err) {
    try { if (output && output.state !== 'finalized') await output.cancel(); } catch { /* nothing to cancel */ }
    try { await store?.discard(); } catch { /* nothing to discard */ }
    throw err;
  } finally {
    compositor?.close();
    mixer?.close();
  }
}
