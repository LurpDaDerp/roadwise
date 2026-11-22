'use strict';
const { localDay } = require('./calendar.js');

const DAY = 86_400_000;

/** The league-week key of an instant (Monday first, in Seattle's calendar day): the Monday's day number. */
function weekKey(ms) {
  const day = localDay(ms, 0);
  const t = Date.UTC(day.y, day.m - 1, day.d);
  const dow = (new Date(t).getUTCDay() + 6) % 7;
  return Math.floor((t - dow * DAY) / DAY);
}

module.exports = { weekKey };
