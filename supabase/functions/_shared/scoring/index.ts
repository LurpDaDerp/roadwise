// v3 (product spec v3, plan §2) — the scoring contract going forward.
export * from './drive';
export * from './rating';
export * from './stats';
export * from './streak';
export * from './thresholds';

// v2 — every export below is @deprecated and goes away once WP6 (device) and WP5 (edge
// functions) have moved to the v3 API above. Kept only so current importers still compile.
export * from './confidence';
export * from './constants';
export * from './context';
export * from './day';
export * from './exposure';
export * from './longTerm';
export * from './quality';
export * from './rewards';
export * from './scoreTrip';
export * from './severity';
export * from './types';
