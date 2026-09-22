#!/usr/bin/env node
'use strict';
/**
 * Generates the three in-drive alert tones into assets/sounds, so the app ships no third-party
 * audio and every byte of every tone can be regenerated from this file.
 *
 *   npm run tones:make
 *
 * Output: 16-bit mono PCM WAV at 44.1 kHz, deterministic (same bytes on every run — no dither, no
 * randomness). The levels differ in pitch, rhythm and loudness, so a driver can tell them apart
 * without looking (design §13.4, product §8.8):
 *   L1  one soft 880 Hz tone, 180 ms, 20 ms ramps                         — a nudge
 *   L2  two tones rising 660 → 990 Hz, 150 ms each, back to back          — a warning
 *   L3  three pairs of 1040 Hz + 780 Hz (120 ms each), 80 ms between pairs — urgent
 * Every segment is shaped by a raised-cosine ramp so nothing clicks at its edges.
 *
 * scripts/__tests__/make-tones.test.ts fails if the committed WAVs drift from this script, so run
 * it after any change here and commit the result.
 */

const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const OUT_DIR = path.resolve(__dirname, '..', 'assets', 'sounds');

/** Peak level per alert level, as a fraction of full scale: louder as urgency rises. */
const AMPLITUDE = { l1: 0.3, l2: 0.5, l3: 0.7 };
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
  const l1 = tone(880, 180, L1_RAMP_MS, AMPLITUDE.l1);
  const l2 = concat([
    tone(660, 150, SEGMENT_RAMP_MS, AMPLITUDE.l2),
    tone(990, 150, SEGMENT_RAMP_MS, AMPLITUDE.l2),
  ]);
  const pair = () => [
    tone(1040, 120, SEGMENT_RAMP_MS, AMPLITUDE.l3),
    tone(780, 120, SEGMENT_RAMP_MS, AMPLITUDE.l3),
  ];
  const l3 = concat([...pair(), silence(L3_GAP_MS), ...pair(), silence(L3_GAP_MS), ...pair()]);
  return { l1: wav(l1), l2: wav(l2), l3: wav(l3) };
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
