/**
 * The app's one crash sink: errors go to EAS Observe (`expo-observe`), Expo's error and startup
 * metrics service, in release builds only. In `__DEV__` and under Jest it does nothing (the callers
 * keep their own dev `console.warn`).
 *
 * Privacy (a teen app): a report carries the error's name, its message and its stack, prefixed with
 * a short context string, and nothing else. No location, coordinate, drive, username, email or token
 * is ever attached, and the text itself is scrubbed (`scrub`) of anything shaped like one before it
 * leaves the phone. That covers uncaught errors too: importing `expo-observe` makes
 * `expo-app-metrics` wrap React Native's global error handler and send the raw error, so
 * `loadObserve` wraps that handler in turn and hands it only a scrubbed copy.
 *
 * The native module is optional: a binary built before `expo-observe` was added (an update that
 * reached an older build) has no `ExpoObserve`, and importing the package there would throw at
 * launch. The package is required only once both native modules answer, and every call is guarded,
 * so reporting can never be what crashes the app.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';
import type { ComponentType } from 'react';

type ObserveLib = typeof import('expo-observe');

/** The part of `Observe` the sink calls. */
export type CrashApi = { reportError(error: unknown): void };

/** The same context and message are reported at most once per this window. */
export const REPORT_REPEAT_MS = 60_000;
/** A launch sends at most this many reports, whatever they are. */
export const MAX_REPORTS_PER_LAUNCH = 50;
/** Fraction of installations that send to Observe. All: the user base is small. */
export const OBSERVE_SAMPLE_RATE = 1;

const MAX_CONTEXT_CHARS = 80;
const MAX_MESSAGE_CHARS = 500;
const MAX_STACK_CHARS = 4000;
/** Dedupe keys kept before old ones are dropped. */
const MAX_SEEN_KEYS = 200;

/** Release builds only: never in a dev bundle, never under Jest. */
const ENABLED = !__DEV__ && process.env.NODE_ENV !== 'test';

const SCRUBS: readonly [RegExp, string][] = [
  // JWTs (Supabase access tokens) and bearer headers.
  [/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, '[token]'],
  [/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [token]'],
  // Email addresses.
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]'],
  // A URL's query string (coordinates, keys and ids travel there).
  [/\?[^\s'"]*=[^\s'"]*/g, '?[query]'],
  // UUIDs (drive, device and user ids).
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[id]'],
  // Long key-like runs with a digit in them (hex secrets, base64 tokens, push tokens).
  [/\b(?=[\w-]*\d)[\w-]{32,}\b/g, '[token]'],
  // Precise decimals: a latitude or longitude (three places is about 100 m).
  [/-?\b\d{1,3}\.\d{3,}\b/g, '[n]'],
];

/** `text` with anything shaped like a token, email, id, query string or coordinate replaced. */
export function scrub(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SCRUBS) out = out.replace(pattern, replacement);
  return out;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The error's name, message and stack, read defensively: a thrown value can be anything. */
function describe(error: unknown): { name: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      name: typeof error.name === 'string' ? error.name : 'Error',
      message: typeof error.message === 'string' ? error.message : '',
      stack: typeof error.stack === 'string' ? error.stack : undefined,
    };
  }
  if (typeof error === 'string') return { name: 'Error', message: error };
  // A plain error object (a Supabase or Postgrest error): only its message, never its details.
  if (error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return { name: 'Error', message: (error as { message: string }).message };
  }
  return { name: 'Error', message: `non-error value (${error === null ? 'null' : typeof error})` };
}

/** A new Error carrying `message` (already scrubbed and clipped) and a scrubbed `name` and `stack`. */
function scrubbedError(name: string, message: string, stack: string | undefined): Error {
  const out = new Error(message);
  out.name = scrub(name);
  out.stack = stack === undefined ? undefined : clip(scrub(stack), MAX_STACK_CHARS);
  return out;
}

/** A scrubbed copy of `error` (name, message and stack), for the uncaught-error path. Never throws. */
export function scrubbedCopy(error: unknown): Error {
  try {
    const { name, message, stack } = describe(error);
    return scrubbedError(name, clip(scrub(message), MAX_MESSAGE_CHARS), stack);
  } catch {
    return new Error('unreadable error');
  }
}

type GlobalHandler = (error: unknown, isFatal?: boolean) => void;
export interface GlobalErrorUtils {
  getGlobalHandler(): GlobalHandler;
  setGlobalHandler(handler: GlobalHandler): void;
}

/**
 * Wraps the current global error handler (the one `expo-app-metrics` installs when it is imported,
 * which sends the error as it is and then chains to React Native's default) so it only ever sees a
 * scrubbed copy of the error.
 */
export function scrubGlobalErrors(utils: GlobalErrorUtils): void {
  const next = utils.getGlobalHandler();
  utils.setGlobalHandler((error, isFatal) => next(scrubbedCopy(error), isFatal));
}

export interface CrashSinkDeps {
  enabled: boolean;
  /** The reporting API, or null when it is not available (no native module, dev, tests). */
  load: () => CrashApi | null;
  now: () => number;
}

export interface CrashSink {
  report(error: unknown, context: string): void;
}

export function createCrashSink(deps: CrashSinkDeps): CrashSink {
  const seen = new Map<string, number>();
  let sent = 0;
  return {
    report(error, context) {
      if (!deps.enabled) return;
      try {
        const { name, message, stack } = describe(error);
        const ctx = clip(scrub(String(context)), MAX_CONTEXT_CHARS);
        const msg = clip(scrub(message), MAX_MESSAGE_CHARS);
        const key = `${ctx}|${name}|${msg}`;
        const at = deps.now();
        const last = seen.get(key);
        if (last !== undefined && at - last < REPORT_REPEAT_MS) return;
        if (sent >= MAX_REPORTS_PER_LAUNCH) return;
        if (seen.size >= MAX_SEEN_KEYS) {
          for (const [k, t] of seen) if (at - t >= REPORT_REPEAT_MS) seen.delete(k);
          if (seen.size >= MAX_SEEN_KEYS) seen.clear();
        }
        seen.set(key, at);
        sent += 1;
        const api = deps.load();
        if (!api) return;
        api.reportError(scrubbedError(name, ctx ? `${ctx}: ${msg}` : msg, stack));
      } catch {
        // Reporting is never the reason something fails.
      }
    },
  };
}

let observe: ObserveLib | null | undefined;

/**
 * `expo-observe`, loaded and configured once, or null: in dev and tests, on a binary without the
 * native modules, or when loading failed. Conservative settings: nothing is sent from a debug
 * build, and no navigation integration (it would send route params) is turned on.
 */
export function loadObserve(): ObserveLib | null {
  if (observe !== undefined) return observe;
  observe = null;
  if (!ENABLED) return observe;
  try {
    if (!requireOptionalNativeModule('ExpoObserve') || !requireOptionalNativeModule('ExpoAppMetrics')) return observe;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- only once the native modules answer
    const lib = require('expo-observe') as ObserveLib;
    // The require just ran expo-app-metrics' handler install; it must never see an unscrubbed error.
    // Without ErrorUtils that install did nothing either, so there is nothing to wrap.
    if (typeof ErrorUtils !== 'undefined') scrubGlobalErrors(ErrorUtils as unknown as GlobalErrorUtils);
    lib.Observe.configure({ dispatchingEnabled: true, dispatchInDebug: false, sampleRate: OBSERVE_SAMPLE_RATE });
    observe = lib;
  } catch {
    observe = null;
  }
  return observe;
}

const sink = createCrashSink({
  enabled: ENABLED,
  load: () => loadObserve()?.Observe ?? null,
  now: () => Date.now(),
});

/** Sends `error` to the crash sink with a short, data-free `context` (e.g. "root screen"). Never throws. */
export function reportError(error: unknown, context: string): void {
  sink.report(error, context);
}

/** `Component` inside Observe's root (it times the first render), or unchanged where Observe is off. */
export function withCrashReporting<P extends Record<string, unknown>>(Component: ComponentType<P>): ComponentType<P> {
  const lib = loadObserve();
  if (!lib) return Component;
  try {
    return lib.ObserveRoot.wrap(Component);
  } catch {
    return Component;
  }
}
