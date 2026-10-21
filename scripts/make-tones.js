#!/usr/bin/env node
'use strict';
/**
 * Generates the in-drive alert tones (three levels, the points-lost cue, four DashPal sounds) into assets/sounds, so the app ships no third-party
 * audio and every byte of every tone can be regenerated from this file.
 *
 *   npm run tones:make
 *
 * Output: 16-bit mono PCM WAV at 44.1 kHz, deterministic (same bytes on every run — no dither, no
 * randomness). The levels differ in pitch and rhythm, so a driver can tell them apart without
 * looking (design §13.4, product §8.8):
 *   L1  one soft 880 Hz tone, 180 ms, 20 ms ramps                         — a nudge
 *   L2  two tones rising 660 → 990 Hz, 150 ms each, back to back          — a warning
 *   L3  three pairs of 1040 Hz + 780 Hz (120 ms each), 80 ms between pairs — urgent
 * Every segment is shaped by a raised-cosine ramp so nothing clicks at its edges.
 *
 * The points-lost cue plays after an alert's own tone each time points come off (and alone for a
 * speeding repeat past its grace), so it is short and unlike every other sound: the only falling
 * pair, low in the register:
 *   points_lost  740 Hz then 494 Hz, 110 ms each, 20 ms apart (240 ms)           — points lost
 *
 * The DashPal dashcam's four sounds (src/dashcam/alerts.ts) are distinct from the levels and from
 * each other, by pitch, direction and rhythm:
 *   dp_glance  two 1175 Hz pips (90 ms, 60 ms apart) then 880 Hz 140 ms   — eyes on the road
 *   dp_drowsy  a slow rising arpeggio 523 → 659 → 784 Hz (220/220/320 ms, 90 ms gaps) — take a break
 *   dp_wake    four fast 1500/1000 Hz pairs (80 ms each, 40 ms between pairs) with odd harmonics,
 *              a harsh square-ish timbre that reads louder at the same peak — wake up (urgent)
 *   dp_phone   a falling 1320 → 990 → 660 Hz run, 120 ms each, back to back — phone down
 *
 * Every level renders near full scale. Alerts must be heard over music and road noise, often
 * through a pocketed speaker, and L1 is the level a driver hears most. L1 is "soft" by its shape
 * (one tone, gentle ramps), not its level; any loudness balance between levels is a tunable
 * runtime gain in the alert player (src/core/alerts/player.ts), never baked into these files.
 *
 * scripts/__tests__/make-tones.test.ts fails if the committed WAVs drift from this script, so run
 * it after any change here and commit the result.
 */

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const OUT_DIR = path.resolve(__dirname, '..', 'assets', 'sounds');

/** Peak level of every tone, as a fraction of full scale: loud, with headroom against clipping. */
const PEAK = 0.9;
/** Ramp length for L1 (the brief's 20 ms) and for the shorter L2/L3 segments. */
const L1_RAMP_MS = 20;
const SEGMENT_RAMP_MS = 10;
/** Silence between L3's three pairs — the pause is what makes the triple rhythm audible. */
const L3_GAP_MS = 80;

const samplesFor = (ms) => Math.round((ms * SAMPLE_RATE) / 1000);

/** A sine segment with raised-cosine fade-in and fade-out; first and last samples are exactly 0. */
function tone(hz, ms, rampMs, amplitude) {
  const n = samplesFor(ms);
  const ramp = samplesFor(rampMs);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const edge = Math.min(i, n - 1 - i);
    const env = edge < ramp ? 0.5 * (1 - Math.cos((Math.PI * edge) / ramp)) : 1;
    out[i] = amplitude * env * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE);
  }
  return out;
}

/**
 * Like `tone`, with odd harmonics (1, 1/3, 1/5 of the fundamental's amplitude) for a harsher,
 * square-ish timbre; normalised so the peak is still `amplitude`.
 */
function harshTone(hz, ms, rampMs, amplitude) {
  const n = samplesFor(ms);
  const ramp = samplesFor(rampMs);
  const raw = new Float64Array(n);
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * hz * i) / SAMPLE_RATE;
    raw[i] = Math.sin(t) + Math.sin(3 * t) / 3 + Math.sin(5 * t) / 5;
    peak = Math.max(peak, Math.abs(raw[i]));
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const edge = Math.min(i, n - 1 - i);
    const env = edge < ramp ? 0.5 * (1 - Math.cos((Math.PI * edge) / ramp)) : 1;
    out[i] = (amplitude * env * raw[i]) / peak;
  }
  return out;
}

const silence = (ms) => new Float64Array(samplesFor(ms));

function concat(parts) {
  const out = new Float64Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Wraps float samples in [-1, 1] as a canonical 44-byte-header PCM WAV. */
function wav(samples) {
  const dataLen = samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767) || 0, 44 + i * 2);
  }
  return buf;
}

function renderTones() {
  const l1 = tone(880, 180, L1_RAMP_MS, PEAK);
  const l2 = concat([
    tone(660, 150, SEGMENT_RAMP_MS, PEAK),
    tone(990, 150, SEGMENT_RAMP_MS, PEAK),
  ]);
  const pair = () => [
    tone(1040, 120, SEGMENT_RAMP_MS, PEAK),
    tone(780, 120, SEGMENT_RAMP_MS, PEAK),
  ];
  const l3 = concat([...pair(), silence(L3_GAP_MS), ...pair(), silence(L3_GAP_MS), ...pair()]);

  const dpGlance = concat([
    tone(1175, 90, SEGMENT_RAMP_MS, PEAK),
    silence(60),
    tone(1175, 90, SEGMENT_RAMP_MS, PEAK),
    silence(60),
    tone(880, 140, SEGMENT_RAMP_MS, PEAK),
  ]);
  const dpDrowsy = concat([
    tone(523, 220, L1_RAMP_MS, PEAK),
    silence(90),
    tone(659, 220, L1_RAMP_MS, PEAK),
    silence(90),
    tone(784, 320, L1_RAMP_MS, PEAK),
  ]);
  const wakePair = () => [harshTone(1500, 80, SEGMENT_RAMP_MS, PEAK), harshTone(1000, 80, SEGMENT_RAMP_MS, PEAK)];
  const dpWake = concat([
    ...wakePair(),
    silence(40),
    ...wakePair(),
    silence(40),
    ...wakePair(),
    silence(40),
    ...wakePair(),
  ]);
  const pointsLost = concat([
    tone(740, 110, SEGMENT_RAMP_MS, PEAK),
    silence(20),
    tone(494, 110, SEGMENT_RAMP_MS, PEAK),
  ]);
  const dpPhone = concat([
    tone(1320, 120, SEGMENT_RAMP_MS, PEAK),
    tone(990, 120, SEGMENT_RAMP_MS, PEAK),
    tone(660, 120, SEGMENT_RAMP_MS, PEAK),
  ]);
  return {
    l1: wav(l1),
    l2: wav(l2),
    l3: wav(l3),
    points_lost: wav(pointsLost),
    dp_glance: wav(dpGlance),
    dp_drowsy: wav(dpDrowsy),
    dp_wake: wav(dpWake),
    dp_phone: wav(dpPhone),
  };
}

module.exports = { renderTones, SAMPLE_RATE };

if (require.main === module) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tones = renderTones();
  for (const [name, bytes] of Object.entries(tones)) {
    fs.writeFileSync(path.join(OUT_DIR, `${name}.wav`), bytes);
  }
  console.log(`tones: wrote ${Object.keys(tones).join(', ')} to assets/sounds`);
}
