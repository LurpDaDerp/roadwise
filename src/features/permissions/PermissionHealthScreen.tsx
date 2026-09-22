import { Ionicons } from '@expo/vector-icons';
import * as Device from 'expo-device';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';

import { recordPrompt, type PromptPermission, type Readiness } from '@/core/permissions';
import { useAppConfig } from '@/data/config/appConfig';
import { createSettingsRepo } from '@/data/db';
import { useDb } from '@/data/queries';
import { TripTopBar } from '@/features/trips/TopBar';
import { Banner, Button, Card, Skeleton, Screen, Text, useTheme } from '@/ui';

import { permissionsCopy as copy, rowConsequence, rowStatus, rowTitle } from './copy';
import { fixFor, HealthRow, type FixTarget } from './HealthRow';
import { guideFor } from './oemGuides';
import {
  defaultPermissionsAdapter,
  markSettingsReturn,
  usePermissionHealth,
  type PermissionHealthDeps,
} from './usePermissionHealth';

/** The disclosure, reached from B2 to repair background location. Cast: typed routes are generated at `expo start`. */
export const REPAIR_HREF = '/permissions/background?reason=repair' as Href;

/**
 * What "Run a test" says: exactly what `readiness()` found. Armed only when drive-sense says
 * armed; "couldn't check" when it cannot say; never a promise that drives will be detected.
 */
export function readinessMessage(r: Readiness): string {
  if (r.armed === null) return copy.test.cantCheck;
  if (r.armed) return copy.test.armed;
  return r.allowed ? copy.test.allowedNotArmed : copy.test.notAllowed;
}

const PROMPT_OF: Partial<Record<FixTarget, PromptPermission>> = {
  requestLocation: 'location',
  requestMotion: 'motion',
  requestNotifications: 'notifications',
};

export interface PermissionHealthScreenDeps extends PermissionHealthDeps {
  /** `expo-device`'s maker name; picks the battery guide. */
  manufacturer?: string | null;
  now?: () => number;
}

/**
 * B2 · Permission health, the single repair place (product §8.3). Status-first rows with one
 * consequence line and a Fix where there is something to fix; `info` rows only explain. Fix
 * buttons are the driver's own taps, so they call the adapter directly and are never throttled
 * (Ruling T8 r1); a request still stamps the 14-day history so the app's own offers wait. A Fix
 * for background location opens the prominent disclosure first, never the OS prompt.
 */
export function PermissionHealthScreen({ deps = {} }: { deps?: PermissionHealthScreenDeps }) {
  const th = useTheme();
  const router = useRouter();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const adapter = deps.adapter ?? defaultPermissionsAdapter();
  const now = deps.now ?? Date.now;
  const manufacturer = deps.manufacturer === undefined ? Device.manufacturer : deps.manufacturer;
  const health = usePermissionHealth(deps);
  const { config } = useAppConfig(deps.appConfig);

  const [pending, setPending] = useState<FixTarget | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  // Back from the disclosure (or anything pushed over this screen): read the phone again. The
  // first focus is the mount, which the hook already reads.
  const focused = useRef(false);
  const { refresh } = health;
  useFocusEffect(
    useCallback(() => {
      if (focused.current) void refresh();
      focused.current = true;
    }, [refresh])
  );

  const onFix = async (target: FixTarget) => {
    if (pending) return;
    setActionFailed(false);
    if (target === 'disclosure' || target === 'reviewDisclosure') {
      router.push(REPAIR_HREF);
      return;
    }
    setPending(target);
    try {
      switch (target) {
        case 'openSettings':
          await markSettingsReturn(settings, now());
          await adapter.openAppSettings();
          break;
        case 'openBatterySettings':
          await markSettingsReturn(settings, now());
          await adapter.openBatterySettings();
          break;
        case 'requestLocation':
          await adapter.requestLocationForeground();
          break;
        case 'requestMotion':
          await adapter.requestMotion();
          break;
        case 'requestNotifications':
          await adapter.requestNotifications();
          break;
      }
      const prompted = PROMPT_OF[target];
      if (prompted) {
        await recordPrompt(settings, prompted, now());
        await refresh();
      }
    } catch {
      setActionFailed(true);
    } finally {
      setPending(null);
    }
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    try {
      setTestResult(readinessMessage(await adapter.readiness()));
    } catch {
      setTestResult(copy.test.cantCheck);
    } finally {
      setTesting(false);
    }
  };

  const back = router.canGoBack() ? () => router.back() : null;

  let body;
  if (health.status === 'error') {
    body = (
      <Banner
        tone="warning"
        message={copy.readError.message}
        action={{ label: copy.readError.retry, onPress: () => void refresh() }}
        testID="permissions-read-error"
      />
    );
  } else if (health.status === 'loading') {
    body = (
      <Card testID="permissions-loading">
        <View accessible accessibilityLabel={copy.loading} style={{ gap: th.space.md }}>
          <Skeleton width="70%" height={24} />
          <Skeleton width="100%" height={56} />
          <Skeleton width="100%" height={56} />
          <Skeleton width="100%" height={56} />
        </View>
      </Card>
    );
  } else {
    const { snapshot, report, context } = health;
    const autoRecordWanted =
      context.autoDetectAvailable !== false && context.autoDetectOn && !context.manualByChoice;
    const summary = copy.summary[report.overall];
    const summaryGlyph = report.overall === 'ok' ? 'checkmark-circle' : 'alert-circle';
    const summaryInk = report.overall === 'ok' ? th.colors.success : th.colors.warning;
    body = (
      <>
        <Card variant="license" testID="permissions-summary">
          <View style={{ flexDirection: 'row', gap: th.space.md, alignItems: 'center' }}>
            <Ionicons name={summaryGlyph} size={28} color={summaryInk} />
            <Text variant="title3" accessibilityRole="header" style={{ flex: 1 }} testID={`permissions-overall-${report.overall}`}>
              {summary}
            </Text>
          </View>
        </Card>
        <Card padded={false} style={{ paddingHorizontal: th.space.lg }}>
          {report.rows.map((row) => {
            const fix = fixFor(row, snapshot);
            const showGuide =
              row.id === 'battery' && (row.status === 'attention' || row.reason === 'cantCheck');
            return (
              <HealthRow
                key={row.id}
                testID={`permission-row-${row.id}`}
                title={rowTitle(row.id, snapshot.platform)}
                statusLabel={rowStatus(row)}
                status={row.status}
                consequence={rowConsequence(row, { snapshot, autoRecordWanted })}
                fix={fix}
                busy={fix !== null && pending === fix}
                onFix={(target) => void onFix(target)}
                guide={showGuide ? guideFor(manufacturer, config.oem_battery_guides) : null}
              />
            );
          })}
        </Card>
      </>
    );
  }

  const drives = health.status === 'ready' && health.context.drives;

  return (
    <Screen scroll testID="permissions-screen">
      <TripTopBar title={copy.title} onBack={back} />
      {body}
      {actionFailed ? <Banner tone="danger" message={copy.actionError} testID="permissions-action-error" /> : null}
      <View style={{ flexGrow: 1 }} />
      {drives && testResult ? (
        // Printed next to the button that asked, and announced when it changes.
        <Text variant="subhead" accessibilityLiveRegion="polite" testID="permissions-test-result">
          {testResult}
        </Text>
      ) : null}
      {drives ? (
        <Button
          label={testing ? copy.test.running : copy.test.run}
          onPress={() => void runTest()}
          loading={testing}
          accessibilityHint={copy.test.hint}
          testID="permissions-run-test"
        />
      ) : null}
    </Screen>
  );
}
