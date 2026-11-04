/**
 * The paired cars as the drive lists read them (iPhone): with 2 or more cars paired, each drive row
 * names the car it was made in and Drive history filters by car. With fewer, nothing shows.
 *
 * One store for every row: the first list on screen reads the car link and listens to the native
 * `carLink` event (a pairing, a forget, a rename all arrive through it) and reads it again when
 * RoadWise returns to the front; the last one gone stops listening. The rows re-render only when
 * the paired cars themselves change (their uids, names or kinds), never on a route change. A read
 * that fails, Android and a native build without the car link leave it as it was: no cars.
 */
import type { CarLinkState, PairedCar } from '@drive-sense';
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';

import type { LocalDrive } from '@/data/queries/rows';

import { outputName } from './model';
import { onCarLink, readCarLink } from './port';

/** The rows and Drive history show the car only with at least this many cars paired now. */
export const CAR_LIST_MIN = 2;

/** A paired car as the lists name it. */
export interface CarLabel {
  uid: string;
  label: string;
}

const NO_CARS: readonly PairedCar[] = Object.freeze([]);
const NO_LABELS: readonly CarLabel[] = Object.freeze([]);

/**
 * The paired cars as the lists name them, in the order they were paired: the phone's name for each
 * (or its kind), a second car of the same name numbered ("CarPlay 2"). Empty with fewer than 2.
 */
export function pairedCarLabels(cars: readonly Pick<PairedCar, 'uid' | 'name' | 'type'>[]): readonly CarLabel[] {
  if (cars.length < CAR_LIST_MIN) return NO_LABELS;
  const used = new Set<string>();
  return cars.map((c) => {
    const base = outputName(c);
    let label = base;
    for (let n = 2; used.has(label.toLowerCase()); n += 1) label = `${base} ${n}`;
    used.add(label.toLowerCase());
    return { uid: c.uid, label };
  });
}

/**
 * The car a drive row names: none with fewer than 2 cars paired (`labels` empty) or on a drive with
 * no car; the car's name now while it is paired, else the name it had on that drive.
 */
export function driveCarLabel(drive: Pick<LocalDrive, 'carUid' | 'carName'>, labels: readonly CarLabel[]): string | null {
  if (labels.length < CAR_LIST_MIN) return null;
  const uid = typeof drive.carUid === 'string' ? drive.carUid : '';
  if (uid === '') return null;
  const now = labels.find((l) => l.uid === uid);
  if (now) return now.label;
  const then = typeof drive.carName === 'string' ? drive.carName.trim() : '';
  return then === '' ? null : then;
}

const sameCars = (a: readonly PairedCar[], b: readonly PairedCar[]): boolean =>
  a.length === b.length && a.every((c, i) => c.uid === b[i]?.uid && c.name === b[i]?.name && c.type === b[i]?.type);

let cars: readonly PairedCar[] = NO_CARS;
let labels: readonly CarLabel[] = NO_LABELS;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;
/** Bumped by every read asked and every event, so a slow read never overwrites a newer state. */
let generation = 0;

function take(s: CarLinkState | null): void {
  // Unknown (a failed read, no car link): keep what is known.
  if (s === null || !Array.isArray(s.cars)) return;
  if (sameCars(cars, s.cars)) return;
  cars = s.cars.length === 0 ? NO_CARS : Object.freeze([...s.cars]);
  labels = pairedCarLabels(cars);
  for (const l of [...listeners]) l();
}

function refresh(): void {
  const mine = ++generation;
  readCarLink().then(
    (s) => {
      if (mine === generation) take(s);
    },
    () => {}
  );
}

function start(): void {
  const off = onCarLink((s) => {
    generation += 1;
    take(s);
  });
  const sub = AppState.addEventListener('change', (next) => {
    if (next === 'active') refresh();
  });
  stop = () => {
    if (typeof off === 'function') off();
    sub.remove();
  };
  refresh();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1 && stop === null && Platform.OS === 'ios') start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stop !== null) {
      const s = stop;
      stop = null;
      generation += 1;
      s();
    }
  };
}

const carsNow = (): readonly PairedCar[] => cars;
const labelsNow = (): readonly CarLabel[] => labels;

/** The paired cars now (iPhone); empty until read, on Android and without the car link. */
export function usePairedCars(): readonly PairedCar[] {
  return useSyncExternalStore(subscribe, carsNow, carsNow);
}

/** The paired cars as the lists name them (`pairedCarLabels`); empty with fewer than 2. */
export function usePairedCarLabels(): readonly CarLabel[] {
  return useSyncExternalStore(subscribe, labelsNow, labelsNow);
}

/** Tests only: forget what the store holds and stop listening. */
export function resetPairedCars(): void {
  stop?.();
  stop = null;
  listeners.clear();
  generation += 1;
  cars = NO_CARS;
  labels = NO_LABELS;
}
