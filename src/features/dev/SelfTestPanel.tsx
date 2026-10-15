// Self-test (U5, R1; drive-sense README §8, §10): runs the native extractor over N1's golden
// vectors and diffs its output against the TypeScript reference, field by field. The vectors'
// `expected` blocks are the reference's own output (`vectors.test.ts` regenerates and compares
// them), so the diff is native against TS. iOS answers the gravity-filter and android-raw vectors
// with `skipped`, which `diffSelfTest` accepts and this panel says. Then it runs the native
// forgot-to-start reminder policy over its decision table (`src/reminder/vectors.ts`); each
// platform skips the other's rows (`diffReminderSelfTest`).
//
// The vector files are loaded here and nowhere else in the app (README §8), and only when the
// developer presses Run: the requires are inside `loadVectors` and `loadReminderVectors`, not at
// module scope.
import {
  diffReminderSelfTest,
  diffSelfTest,
  parseVectors,
  reminderWireVectors,
  type DriveSenseApi,
  type GoldenVector,
  type ReminderVector,
  type SelfTestDiff,
  type VectorDiff,
} from '@drive-sense';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Banner, Button, Card, fontFamilies, Text, useTheme } from '@/ui';

export const selfTestCopy = {
  title: 'Self-test',
  intro:
    'Runs the native feature extraction over the golden vectors, and the native forgot-to-start reminder over its decision table, and compares every field with the TypeScript reference.',
  run: 'Run self-test',
  rerun: 'Run again',
  running: 'Running…',
  allMatch: (n: number) => `All ${n} vectors match the reference`,
  someDiffer: (bad: number, n: number) => `${bad} of ${n} vectors differ from the reference`,
  platform: (p: string) => `Native platform: ${p}`,
  match: 'Match',
  skipped: (reason: string) => `Skipped: ${reason}`,
  differ: (n: number) => `${n} field${n === 1 ? '' : 's'} differ`,
  more: (n: number) => `and ${n} more`,
  values: (expected: string, actual: string) => `expected ${expected}, native ${actual}`,
  failed: (message: string) => `The self-test did not run: ${message}`,
  invalidOutput: (message: string) => `The native output could not be compared: ${message}`,
} as const;

/** N1's golden vectors, in the order the README lists them. */
export const VECTOR_NAMES = [
  'cruise',
  'hard-brake',
  'corner-left',
  'turn-lagged-course',
  'phone-pickup',
  'mount-shift',
  'no-imu',
  'unaligned-start',
  'gravity-filter',
  'android-raw',
] as const;

/** Read and validate every vector file (throws on a malformed one, naming it). */
export function loadVectors(): GoldenVector[] {
  // The gate is spelled out here as build-time constants, so a production bundle folds it to
  // `false` and Metro drops every require inside it: the ~324 KB of vectors never ship (review m3).
  if (__DEV__ || process.env.EXPO_PUBLIC_DIAGNOSTICS === '1') {
    const files: Record<(typeof VECTOR_NAMES)[number], () => unknown> = {
      cruise: () => require('../../../modules/drive-sense/assets/vectors/cruise.json'),
      'hard-brake': () => require('../../../modules/drive-sense/assets/vectors/hard-brake.json'),
      'corner-left': () => require('../../../modules/drive-sense/assets/vectors/corner-left.json'),
      'turn-lagged-course': () => require('../../../modules/drive-sense/assets/vectors/turn-lagged-course.json'),
      'phone-pickup': () => require('../../../modules/drive-sense/assets/vectors/phone-pickup.json'),
      'mount-shift': () => require('../../../modules/drive-sense/assets/vectors/mount-shift.json'),
      'no-imu': () => require('../../../modules/drive-sense/assets/vectors/no-imu.json'),
      'unaligned-start': () => require('../../../modules/drive-sense/assets/vectors/unaligned-start.json'),
      'gravity-filter': () => require('../../../modules/drive-sense/assets/vectors/gravity-filter.json'),
      'android-raw': () => require('../../../modules/drive-sense/assets/vectors/android-raw.json'),
    };
    return parseVectors(JSON.stringify(VECTOR_NAMES.map((name) => files[name]())));
  }
  throw new Error('The golden vectors are not in this build');
}

/** The forgot-to-start reminder's decision table, gated like the golden vectors. */
export function loadReminderVectors(): ReminderVector[] {
  if (__DEV__ || process.env.EXPO_PUBLIC_DIAGNOSTICS === '1') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- gated like the vector files, so a production bundle drops the table
    return (require('../../../modules/drive-sense/src/reminder/vectors') as { REMINDER_VECTORS: ReminderVector[] }).REMINDER_VECTORS;
  }
  throw new Error('The reminder vectors are not in this build');
}

/** One result list: the extraction's, then the reminder's. An unusable output wins. */
export function combineDiffs(a: SelfTestDiff, b: SelfTestDiff): SelfTestDiff {
  if (a.error) return a;
  if (b.error) return b;
  return { ok: a.ok && b.ok, platform: a.platform ?? b.platform, results: [...a.results, ...b.results] };
}

function show(v: unknown): string {
  if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(4) : String(v);
  if (v === undefined) return 'missing';
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; diff: SelfTestDiff }
  | { kind: 'failed'; message: string };

export function SelfTestPanel({ source }: { source: Pick<DriveSenseApi, 'selfTest'> }) {
  const th = useTheme();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    setPhase({ kind: 'running' });
    try {
      const vectors = loadVectors();
      const output = await source.selfTest(JSON.stringify(vectors));
      const rows = loadReminderVectors();
      const reminderOutput = await source.selfTest(JSON.stringify(reminderWireVectors(rows)));
      const diff = combineDiffs(diffSelfTest(vectors, output), diffReminderSelfTest(rows, reminderOutput));
      if (live.current) setPhase({ kind: 'done', diff });
    } catch (e) {
      if (live.current) setPhase({ kind: 'failed', message: e instanceof Error ? e.message : String(e) });
    }
  }, [source]);

  return (
    <Card testID="self-test-panel">
      <Text variant="title3" accessibilityRole="header">
        {selfTestCopy.title}
      </Text>
      <Text variant="subhead" tone="muted">
        {selfTestCopy.intro}
      </Text>
      <Button
        label={
          phase.kind === 'running'
            ? selfTestCopy.running
            : phase.kind === 'idle'
              ? selfTestCopy.run
              : selfTestCopy.rerun
        }
        onPress={() => void run()}
        loading={phase.kind === 'running'}
        variant="secondary"
      />
      {phase.kind === 'failed' ? <Banner tone="danger" message={selfTestCopy.failed(phase.message)} /> : null}
      {phase.kind === 'done' ? <Result diff={phase.diff} gap={th.space.md} /> : null}
    </Card>
  );
}

function Result({ diff, gap }: { diff: SelfTestDiff; gap: number }) {
  const th = useTheme();
  if (diff.error) return <Banner tone="danger" message={selfTestCopy.invalidOutput(diff.error)} />;
  const bad = diff.results.filter((r) => !r.ok).length;
  const n = diff.results.length;
  return (
    <View style={{ gap }}>
      <Banner
        tone={diff.ok ? 'success' : 'danger'}
        message={diff.ok ? selfTestCopy.allMatch(n) : selfTestCopy.someDiffer(bad, n)}
      />
      {diff.platform ? (
        <Text variant="footnote" tone="muted">
          {selfTestCopy.platform(diff.platform)}
        </Text>
      ) : null}
      <View>
        {diff.results.map((r, i) => (
          <VectorRow key={r.name} result={r} first={i === 0} divider={th.colors.divider} />
        ))}
      </View>
    </View>
  );
}

function VectorRow({ result, first, divider }: { result: VectorDiff; first: boolean; divider: string }) {
  const th = useTheme();
  const verdict = result.error
    ? result.error
    : result.skipped
      ? selfTestCopy.skipped(result.skipped)
      : result.ok
        ? selfTestCopy.match
        : selfTestCopy.differ(result.mismatchCount);
  const failed = !result.ok;
  return (
    <View
      testID={`vector-${result.name}`}
      style={{
        gap: th.space.xs,
        paddingVertical: th.space.sm,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: divider,
      }}
    >
      <View style={{ flexDirection: 'row', gap: th.space.md, alignItems: 'baseline' }}>
        <Text variant="body" style={{ flex: 1, fontFamily: fontFamilies.numerals }}>
          {result.name}
        </Text>
        <Text variant="footnote" tone={failed ? 'danger' : 'muted'} style={{ flexShrink: 1, textAlign: 'right' }}>
          {verdict}
        </Text>
      </View>
      {result.mismatches.map((m) => (
        <View key={m.path} style={{ paddingLeft: th.space.md }}>
          <Text variant="footnote" style={{ fontFamily: fontFamilies.numerals }}>
            {m.path}
          </Text>
          <Text variant="caption" tone="muted" style={{ fontFamily: fontFamilies.numerals }}>
            {selfTestCopy.values(show(m.expected), show(m.actual))}
          </Text>
        </View>
      ))}
      {result.mismatchCount > result.mismatches.length ? (
        <Text variant="caption" tone="muted" style={{ paddingLeft: th.space.md }}>
          {selfTestCopy.more(result.mismatchCount - result.mismatches.length)}
        </Text>
      ) : null}
    </View>
  );
}
