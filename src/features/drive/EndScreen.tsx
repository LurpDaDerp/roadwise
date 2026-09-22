/**
 * C8 — the end of a drive (§7.C C8; M3 brief U3, rev1: I16).
 *
 * It captures the trip it is for on mount — the route's `clientTripId` when given, else the
 * host's current one — and waits only for a `lastFinalized` with that id. `lastFinalized` carries
 * over into the next trip (H1 review), so an outcome for any other id is ignored.
 *
 * - `ok: true` → that trip's summary (D1). A short drive stays here: "Short drive saved — too short
 *   to score", with Done.
 * - `ok: false`, or no answer within 10 s → "We couldn't finish saving this drive. It will be saved
 *   the next time RoadWise opens." with Done. (The recovery at launch does finalize a trip left
 *   `recording`, E1 — so the sentence is true in both cases.)
 * - A dry run (the parked simulation, U5) never claims a save or a failure: it stored nothing.
 * - Nothing to wait for (no trip id at all) → Home, with no claim.
 *
 * While mounted it marks itself for the summary notifier: a finalize seen while the app is in the
 * foreground on this screen schedules no notification, since this screen is the answer.
 */
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, View } from 'react-native';

import type { DriveState } from '@/drive/host';
import { useDriveHost } from '@/drive/useDrive';
import { HOME_HREF, tripSummaryHref } from '@/features/trips/routes';
import { Button, Card, Screen, Text, useTheme } from '@/ui';

import { startCopy as copy } from './startCopy';
import { setEndScreenVisible } from './summaryNotifier';

/** How long the screen waits for its own trip's outcome before the honest fallback. */
export const END_WAIT_MS = 10_000;

type Outcome = 'waiting' | 'short' | 'failed' | 'simulation';

const IDLE = new Set<DriveState['status']>(['armed', 'off']);

export function EndScreen({ clientTripId: routeId }: { clientTripId?: string }) {
  const router = useRouter();
  const host = useDriveHost();
  const t = useTheme();
  // Captured once, on mount: the trip this screen is for.
  const [tripId] = useState<string | null>(() => routeId || host.snapshot().clientTripId);
  const [outcome, setOutcome] = useState<Outcome>('waiting');
  const settledRef = useRef(false);

  useEffect(() => {
    setEndScreenVisible(true);
    return () => setEndScreenVisible(false);
  }, []);

  useEffect(() => {
    const settle = (next: Outcome | 'summary' | 'home') => {
      if (settledRef.current) return;
      settledRef.current = true;
      if (next === 'summary' && tripId) router.replace(tripSummaryHref(tripId));
      else if (next === 'home') router.dismissTo(HOME_HREF);
      else if (next !== 'summary') setOutcome(next);
    };

    const judge = (s: DriveState) => {
      if (s.dryRun) {
        if (IDLE.has(s.status)) settle('simulation');
        return;
      }
      if (tripId === null) {
        settle('home');
        return;
      }
      const lf = s.lastFinalized;
      if (!lf || lf.clientTripId !== tripId) return;
      if (!lf.ok) settle('failed');
      else if (lf.short) settle('short');
      else settle('summary');
    };

    judge(host.snapshot());
    const unsubscribe = host.subscribe(judge);
    const timer = setTimeout(() => {
      settle(host.snapshot().dryRun ? 'simulation' : 'failed');
    }, END_WAIT_MS);
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [host, router, tripId]);

  useEffect(() => {
    if (outcome === 'short') AccessibilityInfo.announceForAccessibility(copy.end.short);
    else if (outcome === 'failed') AccessibilityInfo.announceForAccessibility(copy.end.failed);
    else if (outcome === 'simulation') AccessibilityInfo.announceForAccessibility(copy.end.simulation);
  }, [outcome]);

  const done = () => router.dismissTo(HOME_HREF);

  if (outcome === 'waiting') {
    return (
      <Screen>
        <View
          style={{ flex: 1, justifyContent: 'center', alignItems: 'center', gap: t.space.lg }}
          accessibilityLiveRegion="polite"
        >
          <ActivityIndicator color={t.colors.accent} size="large" />
          <View style={{ alignItems: 'center', gap: t.space.xs }}>
            <Text variant="title2" accessibilityRole="header" style={{ textAlign: 'center' }}>
              {copy.end.saving}
            </Text>
            <Text variant="subhead" tone="muted" style={{ textAlign: 'center' }}>
              {copy.end.savingBody}
            </Text>
          </View>
        </View>
      </Screen>
    );
  }

  const face = {
    short: { icon: 'checkmark-circle-outline' as const, title: copy.end.short, body: copy.end.shortBody },
    failed: { icon: 'time-outline' as const, title: null, body: copy.end.failed },
    simulation: { icon: 'flask-outline' as const, title: copy.end.simulation, body: copy.end.simulationBody },
  }[outcome];

  return (
    <Screen>
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Card variant="license">
          <Ionicons
            name={face.icon}
            size={32}
            color={outcome === 'failed' ? t.colors.warning : t.colors.accent}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
          {face.title ? (
            <Text variant="title2" accessibilityRole="header">
              {face.title}
            </Text>
          ) : null}
          <Text variant={face.title ? 'body' : 'headline'} tone={face.title ? 'muted' : 'default'}>
            {face.body}
          </Text>
        </Card>
      </View>
      <Button label={copy.end.done} size="hud" onPress={done} />
    </Screen>
  );
}
