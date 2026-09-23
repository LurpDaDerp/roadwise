/**
 * The rewards data layer (M5 Task 7): the server reads and RPCs, the offline cache, the hooks, the
 * pure view models and the shared copy. Screens are never exported here — each task imports its
 * own screens and copy modules by path, and only Task 7 edits this barrel.
 */
export * from './api';
export * from './cache';
export * from './keys';
export * from './useRewards';
export * from './useEnsureWeek';
export * from './viewModel';
export * from './copy/common';
