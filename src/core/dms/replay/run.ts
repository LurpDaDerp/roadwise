// Runs frames and rows through the engine façade and collects what came out (plan Task 12). Test tooling.
import type { DmsAlertCommand } from '../engine/alerts';
import type { DmsConfig } from '../engine/config';
import { createDmsEngine, type DmsEngine, type DmsEngineInit, type DmsEvent } from '../engine/engine';
import type { DmsTripSummary } from '../engine/summary';
import type { Scenario } from './scenarios';
import { synthDrive, type SynthItem } from './synth';

export interface ReplayResult {
  events: DmsEvent[];
  commands: DmsAlertCommand[];
  summary: DmsTripSummary;
  invariantViolations: number;
  engine: DmsEngine;
}

export const DEFAULT_INIT: DmsEngineInit = { driverSide: 'left', sensitivity: 'normal', alerts: 'live' };

/** Pushes every row and frame in order; ends the drive at the last frame unless `keepOpen`. */
export function replayItems(items: readonly SynthItem[], cfg: DmsConfig, init: DmsEngineInit = DEFAULT_INIT, o: { keepOpen?: boolean; engine?: DmsEngine } = {}): ReplayResult {
  const engine = o.engine ?? createDmsEngine(cfg, init);
  const events: DmsEvent[] = [];
  const commands: DmsAlertCommand[] = [];
  const collect = () => {
    const out = engine.drain();
    events.push(...out.events);
    commands.push(...out.commands);
  };
  let i = 0;
  for (const it of items) {
    if (it.row !== undefined) engine.pushRow(it.row.row, it.row.ex, it.frame.tMs);
    engine.pushFrame(it.frame);
    if (++i % 16 === 0) collect();
  }
  const invariantViolations = engine.snapshot().invariantViolations;
  let summary: DmsTripSummary;
  if (o.keepOpen === true) summary = engine.summary();
  else summary = engine.endDrive(items.length > 0 ? items[items.length - 1]!.frame.tMs : 0).summary;
  collect();
  return { events, commands, summary, invariantViolations, engine };
}

/** A scenario at one frame rate, gaze source and seed. */
export function runScenario(sc: Scenario, fps: number, source: 'geometric' | 'net', seed: number, cfg: DmsConfig, full = false): ReplayResult {
  const items = synthDrive({ fps, seconds: full ? (sc.fullSeconds ?? sc.seconds) : sc.seconds, seed, source, driver: sc.driver, localMinutes: sc.localMinutes });
  return replayItems(items, { ...cfg, gazeSource: source });
}
