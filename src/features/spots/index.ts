/**
 * Problem spots on screen: the Analytics card and sheet, the spot ink and words, and the
 * recompute job the boot starts (`startSpotJobs`). The detection and the driving screen's watcher
 * are in `@/core/spots`; the table and reads in `@/data/db/spots` and `@/data/queries/spots`.
 */
export { DIRECTIONS, spotsCopy, type Direction } from './copy';
export { chipText, dirWord, gettingBetter, howOften, limitText, progress, spotTitle, whatHappens } from './format';
export { SPOT_INK, spotInk, type SpotInk } from './ink';
export { startSpotJobs, toSpotRow, type SpotJobDeps, type SpotJobs } from './recompute';
export { SpotDisc, SpotsCard } from './SpotsCard';
export { SpotSheet } from './SpotSheet';
