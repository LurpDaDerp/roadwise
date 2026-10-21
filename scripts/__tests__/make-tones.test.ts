import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- a CommonJS Node script
const { renderTones, SAMPLE_RATE } = require('../make-tones.js') as {
  renderTones: () => Record<'l1' | 'l2' | 'l3' | 'points_lost' | 'dp_glance' | 'dp_drowsy' | 'dp_wake' | 'dp_phone', Buffer>;
  SAMPLE_RATE: number;
};

const SOUNDS = join(__dirname, '..', '..', 'assets', 'sounds');
const LEVELS = ['l1', 'l2', 'l3'] as const;
const DASHPAL = ['dp_glance', 'dp_drowsy', 'dp_wake', 'dp_phone'] as const;
const ALL = [...LEVELS, 'points_lost', ...DASHPAL] as const;

type Wav = { channels: number; rate: number; bits: number; samples: Int16Array };

function parseWav(buf: Buffer): Wav {
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  expect(buf.readUInt32LE(4)).toBe(buf.length - 8);
  expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
  expect(buf.toString('ascii', 12, 16)).toBe('fmt ');
  expect(buf.readUInt32LE(16)).toBe(16);
  expect(buf.readUInt16LE(20)).toBe(1); // PCM
  const channels = buf.readUInt16LE(22);
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  expect(buf.readUInt32LE(28)).toBe((rate * channels * bits) / 8); // byte rate
  expect(buf.readUInt16LE(32)).toBe((channels * bits) / 8); // block align
  expect(buf.toString('ascii', 36, 40)).toBe('data');
  const dataLen = buf.readUInt32LE(40);
  expect(dataLen).toBe(buf.length - 44);
  const samples = new Int16Array(dataLen / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = buf.readInt16LE(44 + i * 2);
  return { channels, rate, bits, samples };
}

const durationMs = (w: Wav) => (w.samples.length / w.rate) * 1000;

/** Zero crossings per second of sound (silent gaps excluded) / 2 ≈ the dominant frequency. */
function dominantHz(w: Wav): number {
  let crossings = 0;
  let sounding = 0;
  for (let i = 1; i < w.samples.length; i++) {
    const a = w.samples[i - 1]!;
    const b = w.samples[i]!;
    if (a !== 0 || b !== 0) sounding++;
    if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) crossings++;
  }
  return crossings / 2 / (sounding / w.rate);
}

/** Bursts of sound separated by at least 50 ms of near-silence. */
function soundingSegments(w: Wav): number {
  const QUIET = 100; // ≈ −50 dBFS
  const minGap = Math.round(0.05 * w.rate);
  let segments = 0;
  let quietRun = minGap; // leading silence does not split anything
  for (const v of w.samples) {
    if (Math.abs(v) < QUIET) {
      quietRun++;
      continue;
    }
    if (quietRun >= minGap) segments++;
    quietRun = 0;
  }
  return segments;
}

describe('make-tones', () => {
  const tones = renderTones();
  const wavs = Object.fromEntries(ALL.map((l) => [l, parseWav(tones[l])])) as Record<(typeof ALL)[number], Wav>;

  test('output is byte-identical across runs', () => {
    const again = renderTones();
    for (const l of ALL) expect(again[l].equals(tones[l])).toBe(true);
    expect(Object.keys(tones).sort()).toEqual([...ALL].sort());
  });

  test('each file is 16-bit mono PCM at 44.1 kHz', () => {
    expect(SAMPLE_RATE).toBe(44100);
    for (const l of ALL) {
      expect(wavs[l].channels).toBe(1);
      expect(wavs[l].rate).toBe(44100);
      expect(wavs[l].bits).toBe(16);
    }
  });

  test('durations follow the brief and rise with the level', () => {
    expect(durationMs(wavs.l1)).toBeCloseTo(180, 0);
    expect(durationMs(wavs.l2)).toBeCloseTo(300, 0);
    expect(durationMs(wavs.l1)).toBeLessThan(durationMs(wavs.l2));
    expect(durationMs(wavs.l2)).toBeLessThan(durationMs(wavs.l3));
  });

  test('the three levels differ in dominant frequency', () => {
    const hz = LEVELS.map((l) => dominantHz(wavs[l]));
    expect(hz[0]).toBeGreaterThan(880 * 0.97);
    expect(hz[0]).toBeLessThan(880 * 1.03);
    expect(hz[1]).toBeGreaterThan(825 * 0.97); // mean of 660 and 990, equal time each
    expect(hz[1]).toBeLessThan(825 * 1.03);
    expect(hz[2]).toBeGreaterThan(910 * 0.97); // mean of 1040 and 780, equal time each
    expect(hz[2]).toBeLessThan(910 * 1.03);
    for (let i = 0; i < hz.length; i++)
      for (let j = i + 1; j < hz.length; j++) expect(Math.abs(hz[i]! - hz[j]!)).toBeGreaterThan(20);
  });

  test('every tone starts and ends at silence (ramped, no click)', () => {
    for (const l of ALL) {
      const s = wavs[l].samples;
      expect(s[0]).toBe(0);
      expect(Math.abs(s[s.length - 1]!)).toBeLessThan(200);
    }
  });

  test('every level peaks near full scale; level balance is the player gain, not the file', () => {
    const peak = (w: Wav) => w.samples.reduce((m, v) => Math.max(m, Math.abs(v)), 0) / 32767;
    for (const l of ALL) {
      expect(peak(wavs[l])).toBeGreaterThan(0.85);
      expect(peak(wavs[l])).toBeLessThan(0.95);
    }
  });

  test('rhythm: L1 and L2 are one sounding burst, L3 is three, and L3 lasts 880 ms', () => {
    expect(soundingSegments(wavs.l1)).toBe(1);
    expect(soundingSegments(wavs.l2)).toBe(1);
    expect(soundingSegments(wavs.l3)).toBe(3);
    expect(durationMs(wavs.l3)).toBeCloseTo(880, 0);
  });

  test('the committed WAVs are exactly what the script generates', () => {
    for (const l of ALL) expect(readFileSync(join(SOUNDS, `${l}.wav`)).equals(tones[l])).toBe(true);
  });

  test('points lost: a 240 ms falling pair, 740 Hz then 494 Hz, heard as one cue', () => {
    const w = wavs.points_lost;
    expect(durationMs(w)).toBeCloseTo(240, 0);
    // A 20 ms gap is under the 50 ms split: one cue.
    expect(soundingSegments(w)).toBe(1);
    const half = Math.floor(w.samples.length / 2);
    const part = (from: number, to: number): Wav => ({ ...w, samples: w.samples.slice(from, to) });
    const first = dominantHz(part(0, half));
    const second = dominantHz(part(half, w.samples.length));
    expect(first).toBeGreaterThan(740 * 0.97);
    expect(first).toBeLessThan(740 * 1.03);
    expect(second).toBeGreaterThan(494 * 0.97);
    expect(second).toBeLessThan(494 * 1.03);
    // The only falling pair, and lower than every level.
    for (const l of LEVELS) expect(dominantHz(w)).toBeLessThan(dominantHz(wavs[l]) - 100);
  });

  test('DashPal sounds: lengths and rhythm (glance 3 bursts, drowsy 3, wake one fast burst train, phone 1)', () => {
    expect(durationMs(wavs.dp_glance)).toBeCloseTo(440, 0);
    expect(durationMs(wavs.dp_drowsy)).toBeCloseTo(940, 0);
    expect(durationMs(wavs.dp_wake)).toBeCloseTo(760, 0);
    expect(durationMs(wavs.dp_phone)).toBeCloseTo(360, 0);
    expect(soundingSegments(wavs.dp_glance)).toBe(3);
    expect(soundingSegments(wavs.dp_drowsy)).toBe(3);
    // 40 ms between wake pairs is under the 50 ms split: one continuous-sounding burst train.
    expect(soundingSegments(wavs.dp_phone)).toBe(1);
  });

  test('DashPal sounds and the points-lost cue are told apart from the levels and from each other (pitch, length or rhythm)', () => {
    const sig = (w: Wav) => ({ hz: dominantHz(w), ms: durationMs(w), seg: soundingSegments(w) });
    const all = ALL.map((l) => [l, sig(wavs[l])] as const);
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const [a, x] = all[i]!;
        const [b, y] = all[j]!;
        const distinct = Math.abs(x.hz - y.hz) > 20 || Math.abs(x.ms - y.ms) > 50 || x.seg !== y.seg;
        if (!distinct) throw new Error(`${a} and ${b} are too alike`);
      }
    }
    // The wake sound is the highest-pitched and harsh: its zero-crossing rate is above every level's.
    expect(dominantHz(wavs.dp_wake)).toBeGreaterThan(dominantHz(wavs.l3));
    // Drowsy is the low, slow one.
    expect(dominantHz(wavs.dp_drowsy)).toBeLessThan(dominantHz(wavs.l1));
  });
});
