// Sound helpers: reading a trimmed part of a song, measuring loudness, a safety limiter,
// and the short sounds that can play where one song changes to the next.
import { Input, BlobSource, ALL_FORMATS, AudioBufferSink } from 'mediabunny';

const HALF_PI = Math.PI / 2;

// ------------------------------------------------------------------ loudness

/** "K-weighting" filter numbers from the ITU-R BS.1770 loudness standard, for any sample rate. */
function kWeighting(rate) {
  let K = Math.tan((Math.PI * 1681.974450955533) / rate);
  const Q1 = 0.7071752369554196;
  const Vh = Math.pow(10, 3.999843853973347 / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q1 + K * K;
  const shelf = {
    b0: (Vh + (Vb * K) / Q1 + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q1 + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q1 + K * K) / a0,
  };
  K = Math.tan((Math.PI * 38.13547087602444) / rate);
  const Q2 = 0.5003270373238773;
  a0 = 1 + K / Q2 + K * K;
  return { ...shelf, c1: (2 * (K * K - 1)) / a0, c2: (1 - K / Q2 + K * K) / a0 };
}

/** Measures how loud music sounds to a listener (in LUFS), the way broadcasters do. */
export class LoudnessMeter {
  constructor(rate) {
    this.k = kWeighting(rate);
    this.hop = Math.round(rate / 10); // 100 ms pieces
    this.fill = 0;
    this.acc = 0;
    this.pieces = [];
    this.state = new Float64Array(8);
  }

  push(L, R) {
    const { b0, b1, b2, a1, a2, c1, c2 } = this.k;
    const s = this.state;
    let l1 = s[0], l2 = s[1], l3 = s[2], l4 = s[3], r1 = s[4], r2 = s[5], r3 = s[6], r4 = s[7];
    let { acc, fill } = this;
    const hop = this.hop;
    for (let i = 0; i < L.length; i++) {
      let x = L[i];
      let y = b0 * x + l1;
      l1 = b1 * x - a1 * y + l2;
      l2 = b2 * x - a2 * y;
      let z = y + l3;
      l3 = -2 * y - c1 * z + l4;
      l4 = y - c2 * z;
      acc += z * z;
      x = R[i];
      y = b0 * x + r1;
      r1 = b1 * x - a1 * y + r2;
      r2 = b2 * x - a2 * y;
      z = y + r3;
      r3 = -2 * y - c1 * z + r4;
      r4 = y - c2 * z;
      acc += z * z;
      if (++fill === hop) {
        this.pieces.push(acc / hop);
        acc = 0;
        fill = 0;
      }
    }
    s[0] = l1; s[1] = l2; s[2] = l3; s[3] = l4; s[4] = r1; s[5] = r2; s[6] = r3; s[7] = r4;
    this.acc = acc;
    this.fill = fill;
  }

  /** Loudness in LUFS, or null when there was only silence. */
  result() {
    const p = this.pieces;
    const blocks = [];
    for (let i = 0; i + 4 <= p.length; i++) blocks.push((p[i] + p[i + 1] + p[i + 2] + p[i + 3]) / 4);
    const lufs = (v) => -0.691 + 10 * Math.log10(v);
    const loud = blocks.filter((v) => v > 0 && lufs(v) > -70);
    if (!loud.length) return null;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const gate = lufs(mean(loud)) - 10;
    const kept = loud.filter((v) => lufs(v) > gate);
    return kept.length ? lufs(mean(kept)) : null;
  }
}

/** Loudness of (up to two minutes from the middle of) a trimmed part of a file. */
export async function measureLoudness(file, startSec, lengthSec, signal) {
  const span = Math.min(lengthSec, 120);
  const from = startSec + (lengthSec - span) / 2;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return null;
    let meter = null;
    for await (const { buffer } of new AudioBufferSink(track).buffers(from, from + span)) {
      if (signal?.aborted) break;
      meter ??= new LoudnessMeter(buffer.sampleRate);
      const L = buffer.getChannelData(0);
      meter.push(L, buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L);
    }
    return meter ? meter.result() : null;
  } finally {
    input.dispose();
  }
}

// ------------------------------------------------------------------ reading a clip

/**
 * Reads the sound of one trimmed clip, in order, as stereo at the fusion's sample rate.
 * Only a second or so is held in memory at any time.
 */
export class ClipAudioReader {
  constructor(file, startSec, lengthSec, outRate) {
    this.file = file;
    this.startSec = startSec;
    this.lengthSec = lengthSec;
    this.outRate = outRate;
    this.silent = true;
    this.made = 0; // output samples produced so far
  }

  async open() {
    this.input = new Input({ source: new BlobSource(this.file), formats: ALL_FORMATS });
    const track = await this.input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) return this;
    this.iter = new AudioBufferSink(track).buffers(Math.max(0, this.startSec - 0.05), this.startSec + this.lengthSec + 0.25);
    const first = await this.iter.next();
    if (first.done) return this;

    // Trust the rate of the decoded sound, not the file header (some AAC files report half).
    this.srcRate = first.value.buffer.sampleRate;
    this.exact = this.srcRate === this.outRate;
    this.ratio = this.srcRate / this.outRate;
    // Position, counted in source samples, of the very first output sample.
    this.origin = this.exact ? Math.round(this.startSec * this.srcRate) : this.startSec * this.srcRate;
    this.cap = 1 << 16;
    this.fL = new Float32Array(this.cap);
    this.fR = new Float32Array(this.cap);
    this.fStart = Math.floor(this.origin) - 2;
    this.fLen = 0;
    this.ended = false;
    this.silent = false;
    this._append(first.value);
    return this;
  }

  _append({ buffer, timestamp }) {
    const n = buffer.length;
    const idx = Math.round(timestamp * this.srcRate);
    const end = this.fStart + this.fLen;
    const skip = Math.max(0, end - idx); // part we already have, or that lies before the clip
    if (skip >= n) return;
    const gap = Math.max(0, idx - end); // silence between two pieces
    const add = gap + n - skip;
    if (this.fLen + add > this.cap) {
      while (this.fLen + add > this.cap) this.cap *= 2;
      const nl = new Float32Array(this.cap);
      const nr = new Float32Array(this.cap);
      nl.set(this.fL.subarray(0, this.fLen));
      nr.set(this.fR.subarray(0, this.fLen));
      this.fL = nl;
      this.fR = nr;
    }
    const at = this.fLen;
    if (gap) {
      this.fL.fill(0, at, at + gap);
      this.fR.fill(0, at, at + gap);
    }
    const ch0 = buffer.getChannelData(0);
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0;
    this.fL.set(skip ? ch0.subarray(skip) : ch0, at + gap);
    this.fR.set(skip ? ch1.subarray(skip) : ch1, at + gap);
    this.fLen += add;
  }

  async _fillTo(index) {
    while (!this.ended && this.fStart + this.fLen <= index) {
      const next = await this.iter.next();
      if (next.done) this.ended = true;
      else this._append(next.value);
    }
  }

  _dropBefore(index) {
    const k = Math.min(this.fLen, index - this.fStart);
    if (k <= 0) return;
    this.fL.copyWithin(0, k, this.fLen);
    this.fR.copyWithin(0, k, this.fLen);
    this.fStart += k;
    this.fLen -= k;
  }

  /** The next n samples: { L, R } Float32Arrays. Silence once the file runs out. */
  async read(n) {
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    if (this.silent) return { L, R };
    const m0 = this.made;
    this.made += n;

    if (this.exact) {
      const first = this.origin + m0;
      await this._fillTo(first + n - 1);
      const from = Math.max(first, this.fStart);
      const to = Math.min(first + n, this.fStart + this.fLen);
      if (to > from) {
        L.set(this.fL.subarray(from - this.fStart, to - this.fStart), from - first);
        R.set(this.fR.subarray(from - this.fStart, to - this.fStart), from - first);
      }
      this._dropBefore(first + n);
      return { L, R };
    }

    // Different sample rate: smooth (cubic) resampling.
    const { ratio, origin } = this;
    await this._fillTo(Math.floor(origin + (m0 + n - 1) * ratio) + 2);
    const { fL, fR, fStart, fLen } = this;
    for (let k = 0; k < n; k++) {
      const p = origin + (m0 + k) * ratio;
      const i = Math.floor(p);
      const t = p - i;
      const j = i - fStart;
      if (j < 1 || j + 2 >= fLen) {
        if (j >= 0 && j < fLen) { L[k] = fL[j]; R[k] = fR[j]; }
        continue;
      }
      let a = fL[j - 1], b = fL[j], c = fL[j + 1], d = fL[j + 2];
      L[k] = b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
      a = fR[j - 1]; b = fR[j]; c = fR[j + 1]; d = fR[j + 2];
      R[k] = b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
    }
    this._dropBefore(Math.floor(origin + (m0 + n) * ratio) - 1);
    return { L, R };
  }

  close() {
    try { this.iter?.return?.(); } catch { /* already finished */ }
    try { this.input?.dispose(); } catch { /* already closed */ }
    this.iter = null;
    this.silent = true;
  }
}

// ------------------------------------------------------------------ limiter

/** Turns the volume down for an instant whenever the mix would otherwise distort. */
export class Limiter {
  constructor(rate, ceiling = 0.95) {
    this.ceiling = ceiling;
    this.release = Math.exp(-1 / (0.08 * rate));
    this.env = 0;
  }

  process(L, R) {
    const { ceiling, release } = this;
    let env = this.env;
    for (let i = 0; i < L.length; i++) {
      const peak = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      env = peak > env ? peak : env * release;
      if (env > ceiling) {
        const g = ceiling / env;
        L[i] *= g;
        R[i] *= g;
      }
    }
    this.env = env;
  }
}

// ------------------------------------------------------------------ join sounds

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

function synth(rate, seconds, build) {
  const n = Math.round(seconds * rate);
  const buf = { n, L: new Float32Array(n), R: new Float32Array(n) };

  /** Band-pass filtered noise whose centre frequency can move over time. */
  const noise = (from, to, freqAt, gainAt, panAt, seed) => {
    const rand = rng(seed);
    let low = 0;
    let band = 0;
    for (let i = Math.round(from * rate); i < Math.min(n, Math.round(to * rate)); i++) {
      const t = i / rate;
      const f = 2 * Math.sin((Math.PI * Math.min(7000, freqAt(t))) / rate);
      low += f * band;
      const high = rand() - low - 0.55 * band;
      band += f * high;
      const s = band * gainAt(t);
      const pan = panAt ? panAt(t) : 0.5;
      buf.L[i] += s * Math.cos(pan * HALF_PI);
      buf.R[i] += s * Math.sin(pan * HALF_PI);
    }
  };
  const tone = (start, length, freqAt, gainAt) => {
    let phase = 0;
    for (let i = Math.round(start * rate); i < Math.min(n, Math.round((start + length) * rate)); i++) {
      const t = i / rate - start;
      phase += (2 * Math.PI * freqAt(t)) / rate;
      const s = Math.sin(phase) * gainAt(t) * Math.min(1, t / 0.003);
      buf.L[i] += s;
      buf.R[i] += s;
    }
  };
  build(noise, tone);

  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf.L[i]), Math.abs(buf.R[i]));
  const k = 0.8 / peak;
  for (let i = 0; i < n; i++) { buf.L[i] *= k; buf.R[i] *= k; }
  return buf;
}

/** `anchor` = the moment inside the sound (seconds) that lands exactly on the change. */
export const SOUNDS = [
  {
    id: 'whoosh', name: 'Whoosh', anchor: 0.7, seconds: 1.4,
    build: (noise) => noise(0, 1.4, (t) => 280 * Math.pow(20, Math.sin((Math.PI * t) / 1.4)), (t) => Math.sin((Math.PI * t) / 1.4) ** 2, (t) => t / 1.4, 11),
  },
  {
    id: 'chime', name: 'Chime', anchor: 0.2, seconds: 2.4,
    build: (noise, tone) => [1318.51, 1661.22, 1975.53, 2637.02].forEach((f0, k) => {
      tone(k * 0.1, 2.2, () => f0, (t) => 0.5 * Math.exp(-t * 3));
      tone(k * 0.1, 1.0, () => f0 * 2.76, (t) => 0.16 * Math.exp(-t * 6));
      tone(k * 0.1, 0.6, () => f0 * 5.4, (t) => 0.07 * Math.exp(-t * 10));
    }),
  },
  {
    id: 'drums', name: 'Drum roll', anchor: 1.2, seconds: 2.4,
    build: (noise, tone) => {
      [0, 0.27, 0.49, 0.67, 0.82, 0.94, 1.03, 1.11].forEach((start, k) => {
        const f0 = 175 - k * 11;
        tone(start, 0.32, (t) => f0 * (1 + 0.7 * Math.exp(-t * 35)), (t) => (0.55 + k * 0.05) * Math.exp(-t * 10));
        noise(start, start + 0.05, () => 2500, (t) => 0.5 * Math.exp(-(t - start) * 80), null, 20 + k);
      });
      tone(1.2, 0.5, (t) => 48 + 70 * Math.exp(-t * 25), (t) => 1.1 * Math.exp(-t * 9));
      noise(1.2, 2.4, () => 6500, (t) => 1.3 * Math.exp(-(t - 1.2) * 4), null, 41);
    },
  },
  {
    id: 'riser', name: 'Rising swell', anchor: 2.2, seconds: 2.9,
    build: (noise, tone) => {
      noise(0, 2.2, (t) => 400 * Math.pow(16, t / 2.2), (t) => 1.1 * (t / 2.2) ** 2.2, (t) => 0.5 + 0.35 * Math.sin(t * 9), 77);
      tone(0, 2.2, (t) => 196 * Math.pow(8, t / 2.2), (t) => 0.3 * (t / 2.2) ** 2);
      tone(2.2, 0.6, (t) => 45 + 80 * Math.exp(-t * 22), (t) => 1.2 * Math.exp(-t * 7));
      noise(2.2, 2.9, () => 3000, (t) => 0.9 * Math.exp(-(t - 2.2) * 9), null, 78);
    },
  },
];

const soundCache = new Map();

/**
 * Returns { L, R, anchor } for a sound at the wanted sample rate.
 * `loadCustom(id)` must return a Blob for sounds the person added themselves (or null).
 */
export async function getSound(id, rate, loadCustom) {
  const key = `${id}@${rate}`;
  if (soundCache.has(key)) return soundCache.get(key);
  let sound = null;
  const built = SOUNDS.find((s) => s.id === id);
  if (built) {
    const buf = synth(rate, built.seconds, built.build);
    sound = { L: buf.L, R: buf.R, anchor: built.anchor };
  } else if (loadCustom) {
    const blob = await loadCustom(id);
    if (blob) sound = await decodeSound(blob, rate);
  }
  if (sound) soundCache.set(key, sound);
  return sound;
}

export const forgetSound = (id) => {
  for (const key of [...soundCache.keys()]) if (key.startsWith(`${id}@`)) soundCache.delete(key);
};

/** Decodes a short sound file the person picked (at most 12 seconds are used). */
export async function decodeSound(blob, rate) {
  const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Ctx(2, 1, rate);
  const data = await blob.arrayBuffer();
  const decoded = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
  const n = Math.min(decoded.length, rate * 12);
  const L = decoded.getChannelData(0).slice(0, n);
  const R = (decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0)).slice(0, n);
  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  const k = Math.min(4, 0.8 / peak);
  for (let i = 0; i < n; i++) { L[i] *= k; R[i] *= k; }
  // fade the very end so a cut-off sound does not click
  const tail = Math.min(n, Math.round(rate * 0.05));
  for (let i = 0; i < tail; i++) { const g = i / tail; L[n - 1 - i] *= g; R[n - 1 - i] *= g; }
  return { L, R, anchor: n / rate / 2, seconds: n / rate };
}

let player = null;
let playing = null;

/** Plays a join sound out loud so the person can hear what it is. */
export async function playSound(id, loadCustom) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  player ??= new Ctx();
  if (player.state === 'suspended') await player.resume();
  const sound = await getSound(id, player.sampleRate, loadCustom);
  if (!sound) return;
  try { playing?.stop(); } catch { /* not playing */ }
  const buffer = player.createBuffer(2, sound.L.length, player.sampleRate);
  buffer.getChannelData(0).set(sound.L);
  buffer.getChannelData(1).set(sound.R);
  playing = player.createBufferSource();
  playing.buffer = buffer;
  playing.connect(player.destination);
  playing.start();
}
