import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';

import type { PermissionsAdapter } from '@/core/permissions';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { TopBar } from '@/features/settings/parts';
import { Button, Card, Screen, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../copy';
import { createSetupFlow, type SetupDeps, type SetupFlow, type SetupPhase } from '../setup';
import { useDashcamRuntime } from './useDashcam';
import { useDriveBusy } from './useDriveBusy';

const copy = dashpalCopy.setup;

export interface SetupPanelDeps {
  adapter?: PermissionsAdapter;
  platform?: 'ios' | 'android';
  flow?: (base: SetupDeps) => SetupFlow;
}

/**
 * `/settings/dashcam-setup`: the DashPal setup flow (`../setup.ts`), from Settings, the auto prompt
 * (`found`: the dashcam it saw) or the box's `roadwise://dashpal` link. Refuses while a drive is open;
 * the Bluetooth permission is asked here, on this explicit action only.
 */
export function SetupScreen({ found, deps = {} }: { found?: string; deps?: SetupPanelDeps }) {
  const router = useRouter();
  return (
    <Screen scroll testID="dashcam-setup-screen">
      <TopBar title={copy.title} />
      <SetupPanel found={found} deps={deps} onClose={() => (router.canGoBack() ? router.back() : undefined)} />
    </Screen>
  );
}

/**
 * The setup flow's body, also shown inline by the onboarding step (onboarding cannot leave its own
 * routes). `onClose`: Done / Cancel; `onPhase`: the step follows the outcome.
 */
export function SetupPanel({
  found,
  deps = {},
  onClose,
  onPhase,
}: {
  found?: string;
  deps?: SetupPanelDeps;
  onClose(): void;
  onPhase?(p: SetupPhase): void;
}) {
  const th = useTheme();
  const runtime = useDashcamRuntime();
  const isBusy = useDriveBusy();
  const platform = deps.platform ?? (Platform.OS === 'ios' ? 'ios' : 'android');
  const [phase, setPhase] = useState<SetupPhase>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);

  const flow = useMemo(() => {
    void attempt;
    const adapter = deps.adapter ?? defaultPermissionsAdapter();
    const base: SetupDeps = {
      platform,
      transport: () => runtime?.transport() ?? null,
      requestBluetooth: () => adapter.requestBluetooth(),
      isBusy,
      optIn: async () => runtime?.optIn(),
      pair: async (record) => runtime?.pair(record),
      paired: () => runtime?.state().link.paired ?? null,
      now: Date.now,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      preferId: found,
    };
    return (deps.flow ?? createSetupFlow)(base);
  }, [attempt, deps.adapter, deps.flow, platform, runtime, isBusy, found]);

  useEffect(() => {
    const off = flow.subscribe((p) => {
      setPhase(p);
      onPhase?.(p);
    });
    void flow.start();
    return () => {
      off();
      void flow.cancel();
    };
    // `onPhase` is read live through the subscription; a new one does not restart the flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  const retry = () => setAttempt((n) => n + 1);
  const close = onClose;

  let body: string;
  let actions: { label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'ghost'; testID: string }[] = [];
  switch (phase.kind) {
    case 'busy':
      body = copy.busy;
      actions = [{ label: dashpalCopy.setup.doneButton, onPress: close, testID: 'setup-close' }];
      break;
    case 'idle':
    case 'permission':
      body = copy.permission;
      break;
    case 'denied':
      body = copy.denied;
      actions = [
        { label: dashpalCopy.screen.fix.openSettings, onPress: () => void (deps.adapter ?? defaultPermissionsAdapter()).openAppSettings().catch(() => {}), testID: 'setup-open-settings' },
        { label: copy.tryAgain, onPress: retry, variant: 'secondary', testID: 'setup-retry' },
      ];
      break;
    case 'off':
      body = copy.off;
      actions = [{ label: copy.tryAgain, onPress: retry, testID: 'setup-retry' }];
      break;
    case 'unavailable':
      body = copy.unavailable;
      actions = [{ label: dashpalCopy.setup.doneButton, onPress: close, testID: 'setup-close' }];
      break;
    case 'scanning':
      body = copy.scanning;
      break;
    case 'connecting':
      body = copy.connecting;
      break;
    case 'confirm':
      body = copy.identify;
      actions = [
        { label: copy.yes, onPress: () => flow.answer(true), testID: 'setup-yes' },
        { label: copy.no, onPress: () => flow.answer(false), variant: 'secondary', testID: 'setup-no' },
      ];
      break;
    case 'bonding':
      body = copy.bonding[platform];
      break;
    case 'finishing':
      body = copy.finishing;
      break;
    case 'none_found':
      body = copy.noneFound;
      actions = [{ label: copy.tryAgain, onPress: retry, testID: 'setup-retry' }];
      break;
    case 'done':
      body = copy.done(phase.paired.name);
      actions = [{ label: copy.doneButton, onPress: close, testID: 'setup-done' }];
      break;
    case 'failed':
      body = phase.reason === 'ios_forget_first' ? copy.iosForgetFirst : copy.failed;
      actions = [{ label: copy.tryAgain, onPress: retry, testID: 'setup-retry' }];
      break;
    case 'cancelled':
      body = copy.failed;
      actions = [{ label: copy.tryAgain, onPress: retry, testID: 'setup-retry' }];
      break;
  }
  const working = ['idle', 'permission', 'scanning', 'connecting', 'bonding', 'finishing'].includes(phase.kind);

  return (
    <View style={{ gap: th.space.lg }} testID="dashcam-setup-panel">
      <Card>
        <Text variant="body" accessibilityLiveRegion="polite" testID={`setup-phase-${phase.kind}`}>
          {body}
        </Text>
      </Card>
      <View style={{ gap: th.space.sm }}>
        {actions.map((a) => (
          <Button key={a.testID} label={a.label} variant={a.variant ?? 'primary'} onPress={a.onPress} testID={a.testID} />
        ))}
        {working ? <Button label={copy.cancel} variant="ghost" onPress={close} testID="setup-cancel" /> : null}
      </View>
    </View>
  );
}
