'use strict';
/** Local time in Seattle: the demo drivers all live there. */
require('./tshook.js');
const { dayKey } = require('../../src/lib/time.ts');

const TZ = 'America/Los_Angeles';

function tzOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The instant of a Seattle wall-clock time (`minutes` after local midnight of `day`). */
function localInstant(day, minutes) {
  const guess = Date.UTC(day.y, day.m - 1, day.d, 0, minutes);
  const first = guess - tzOffsetMs(guess);
  return guess - tzOffsetMs(first);
}

/** The Seattle calendar day `back` days before the one holding `now`. */
function localDay(now, back) {
  const [y, m, d] = dayKey(new Date(now), TZ).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d - back));
  const iso = `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay(), back, iso };
}

const isWeekend = (day) => day.dow === 0 || day.dow === 6;

module.exports = { TZ, localInstant, localDay, isWeekend, dayKey };
