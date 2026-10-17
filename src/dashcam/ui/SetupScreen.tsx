import { useRouter, type Href } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Platform, View } from 'react-native';

import type { PermissionsAdapter } from '@/core/permissions';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { TopBar } from '@/features/settings/parts';
import { SETTINGS_HREFS } from '@/features/settings/routes';
import { Banner, Button, Card, Screen, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../copy';
import { dashpalSecrets, type DashpalSecrets } from '../secure';
import { createSetupFlow, type SetupDeps, type SetupFailure, type SetupFlow, type SetupPhase } from '../setup';
import { useDashcamRuntime } from './useDashcam';
import { useDriveBusy, useDriveChanges } from './useDriveBusy';

const copy = dashpalCopy.setup;
const wiz = dashpalCopy.wizard;

/** What the setup route opens on: a DashPal the nearby prompt found, or Set up again of the paired one. */
export interface SetupTarget {
  found?: string;
  again?: boolean;
}

/** The setup href for a target. */
export function setupHref(target: SetupTarget = {}): Href {
  const q: string[] = [];
  if (target.found) q.push(`found=${encodeURIComponent(target.found)}`);
  if (target.again) q.push('again=1');
  return (q.length > 0 ? `${String(SETTINGS_HREFS.dashcamSetup)}?${q.join('&')}` : SETTINGS_HREFS.dashcamSetup) as Href;
}

/** The setup route's params as a target (the inverse of `setupHref`). */
export function setupTargetOf(params: { found?: string | string[]; again?: string | string[] }): SetupTarget {
  const one = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const found = one(params.found);
  return { ...(found ? { found } : {}), ...(one(params.again) === '1' ? { again: true } : {}) };
}

export interface SetupPanelDeps {
  adapter?: PermissionsAdapter;
  platform?: 'ios' | 'android';
  flow?: (base: SetupDeps) => SetupFlow;
  secrets?: DashpalSecrets;
  now?: () => number;
}

/**
 * `/settings/dashcam-setup`: the DashPal setup flow (`../setup.ts`), from Settings, the nearby prompt
 * (`found`) or Set up again (`again`). Refuses while a drive is open; Bluetooth is asked here, on
 * this explicit action only.
 */
export function SetupScreen({ target = {}, deps = {} }: { target?: SetupTarget; deps?: SetupPanelDeps }) {
  const router = useRouter();
  return (
    <Screen scroll testID="dashcam-setup-screen">
      <TopBar title={copy.title} />
      <SetupPanel target={target} deps={deps} onClose={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
    </Screen>
  );
}

export function failureText(reason: SetupFailure, name: string | null): string {
  const f = wiz.failed;
  switch (reason) {
    case 'not_found':
      return f.not_found(name);
    case 'window_closed':
      return f.window_closed(name);
    case 'lost':
      return f.lost(name);
    case 'none_nearby':
    case 'setup_busy':
    case 'unverified':
    case 'update_firmware':
    case 'update_app':
    case 'mtu':
    case 'ios_forget_first':
    case 'expired':
    case 'save_failed':
    case 'error':
      return f[reason];
  }
}

/**
 * The setup flow's body, also shown inline by the onboarding step (onboarding cannot leave its own
 * routes): one tap on Pair pairs; Next finishes. `onClose`: Done / Cancel; `onPhase`: the step
 * follows the outcome.
 */
export function SetupPanel({
  target = {},
  deps = {},
  onClose,
  onPhase,
}: {
  target?: SetupTarget;
  deps?: SetupPanelDeps;
  onClose(): void;
  onPhase?(p: SetupPhase): void;
}) {
  const th = useTheme();
  const runtime = useDashcamRuntime();
  const isBusy = useDriveBusy();
  const onDriveChange = useDriveChanges();
  const platform = deps.platform ?? (Platform.OS === 'ios' ? 'ios' : 'android');
  const now = deps.now ?? Date.now;
  const [phase, setPhase] = useState<SetupPhase>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const { found, again } = target;

  const flow = useMemo(() => {
    void attempt;
    const adapter = deps.adapter ?? defaultPermissionsAdapter();
    const base: SetupDeps = {
      platform,
      transport: () => runtime?.transport() ?? null,
      requestBluetooth: () => adapter.requestBluetooth(),
      isBusy,
      onDriveChange,
      optIn: async () => runtime?.optIn(),
      pair: async (record) => runtime?.pair(record),
      paired: () => runtime?.state().link.paired ?? null,
      keyRefused: (d) => {
        const l = runtime?.state().link;
        return l?.repairCause === 'unknown_phone' && l.paired?.dashcamId === d;
      },
      stepAside: () => runtime?.stepAside(),
      resumePaired: async () => runtime?.resumePaired(),
      secrets: deps.secrets ?? dashpalSecrets,
      notePhones: (dashcamId, phones) => runtime?.notePhones(dashcamId, phones),
      now,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
    return (deps.flow ?? createSetupFlow)(base);
    // The flow starts over only on a new attempt or a new runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, deps.adapter, deps.flow, deps.secrets, platform, runtime, isBusy, onDriveChange]);

  useEffect(() => {
    const off = flow.subscribe((p) => {
      setPhase(p);
      onPhase?.(p);
    });
    void flow.start({
      ...(found ? { target: { peripheralId: found, name: null, adv: 'new' as const } } : {}),
      ...(again ? { again: true } : {}),
    });
    return () => {
      off();
      void flow.cancel();
    };
    // `onPhase` is read live through the subscription; a new one does not restart the flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  const restart = () => setAttempt((n) => n + 1);
  const close = onClose;
  const cancel = () => {
    void flow.cancel();
    onClose();
  };
  const openSettings = () => void (deps.adapter ?? defaultPermissionsAdapter()).openAppSettings().catch(() => {});

  let body: string | null = null;
  let extra: string | null = null;
  let actions: { label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'ghost'; testID: string }[] = [];
  let working = false;
  switch (phase.kind) {
    case 'busy':
      body = copy.busy;
      actions = [{ label: wiz.failed.close, onPress: close, testID: 'setup-close' }];
      break;
    case 'idle':
    case 'permission':
      body = copy.permission;
      working = true;
      break;
    case 'denied':
      body = copy.denied;
      actions = [
        { label: dashpalCopy.screen.fix.openSettings, onPress: openSettings, testID: 'setup-open-settings' },
        { label: wiz.failed.tryAgain, onPress: restart, variant: 'secondary', testID: 'setup-retry' },
      ];
      break;
    case 'off':
      body = copy.off;
      actions = [{ label: wiz.failed.tryAgain, onPress: restart, testID: 'setup-retry' }];
      break;
    case 'unavailable':
      body = copy.unavailable;
      actions = [{ label: wiz.failed.close, onPress: close, testID: 'setup-close' }];
      break;
    case 'search':
      body = wiz.search.title;
      extra = wiz.search.body;
      working = true;
      break;
    case 'choose':
      body = wiz.search.chooseTitle;
      actions = phase.candidates.map((c) => ({
        label: `${c.name ?? 'DashPal'} · ${c.adv === 'open' ? wiz.search.chooseOpen : wiz.search.chooseNew}`,
        onPress: () => flow.pick(c.id),
        variant: 'secondary' as const,
        testID: `setup-pick-${c.id}`,
      }));
      working = true;
      break;
    case 'confirm':
      body = phase.mode === 'again' ? wiz.confirm.titleAgain(phase.name) : wiz.confirm.title(phase.name);
      extra = [wiz.confirm.body, phase.replaces ? wiz.confirm.replaces(phase.replaces) : null].filter(Boolean).join(' ');
      actions = [{ label: wiz.confirm.pair, onPress: () => flow.pair(), testID: 'setup-pair' }];
      working = true;
      break;
    case 'press_button':
      body = wiz.pressButton;
      working = true;
      break;
    case 'waiting_busy':
      body = wiz.waitingBusy;
      working = true;
      break;
    case 'connecting':
      body = phase.reconnecting ? wiz.connecting.reconnecting : wiz.connecting.title(phase.name);
      extra = wiz.connecting.body;
      working = true;
      break;
    case 'connected':
      body = wiz.connecting.done;
      working = true;
      break;
    case 'instructions':
      body = phase.reconnecting ? wiz.connecting.reconnecting : wiz.connecting.done;
      extra = phase.holdLeftS !== null ? wiz.holdLeft(phase.holdLeftS) : null;
      actions = [{ label: wiz.instructions.nextSkip, onPress: () => flow.next(), testID: 'setup-next' }];
      working = true;
      break;
    case 'finishing':
      body = wiz.finishing;
      break;
    case 'stopping':
      body = wiz.finishing;
      break;
    case 'done':
      body = wiz.done.title;
      extra = wiz.done.body(phase.paired.name);
      actions = [{ label: wiz.done.button, onPress: close, testID: 'setup-done' }];
      break;
    case 'failed':
      body = failureText(phase.reason, phase.name);
      actions =
        phase.retry === 'none'
          ? [{ label: wiz.failed.close, onPress: cancel, testID: 'setup-close' }]
          : [
              { label: wiz.failed.tryAgain, onPress: () => (phase.retry === 'restart' ? restart() : void flow.retry()), testID: 'setup-retry' },
              { label: wiz.failed.close, onPress: cancel, variant: 'ghost', testID: 'setup-close' },
            ];
      break;
    case 'cancelled':
      body = wiz.failed.error;
      actions = [{ label: wiz.failed.tryAgain, onPress: restart, testID: 'setup-retry' }];
      break;
  }

  return (
    <View style={{ gap: th.space.lg }} testID="dashcam-setup-panel">
      <Card>
        <Text variant="body" accessibilityLiveRegion="polite" testID={`setup-phase-${phase.kind}`}>
          {body}
        </Text>
        {extra ? (
          <Text variant="callout" tone="muted" style={{ marginTop: th.space.sm }} testID="setup-extra">
            {extra}
          </Text>
        ) : null}
        {phase.kind === 'done' && phase.phones !== null && phase.phones >= 2 ? (
          <Text variant="callout" tone="muted" style={{ marginTop: th.space.sm }} testID="setup-phones">
            {wiz.done.phones(phase.phones)}
          </Text>
        ) : null}
        {phase.kind === 'done' && phase.aimedElsewhere ? (
          <Text variant="callout" tone="muted" style={{ marginTop: th.space.sm }} testID="setup-aimed-elsewhere">
            {wiz.done.aimedElsewhere}
          </Text>
        ) : null}
      </Card>
      {phase.kind === 'done' && phase.notAllYours ? <Banner tone="warning" message={wiz.done.notAllYours} testID="setup-not-all-yours" /> : null}
      <View style={{ gap: th.space.sm }}>
        {actions.map((a) => (
          <Button key={a.testID} label={a.label} variant={a.variant ?? 'primary'} onPress={a.onPress} testID={a.testID} />
        ))}
        {working ? <Button label={wiz.cancel} variant="ghost" onPress={cancel} testID="setup-cancel" /> : null}
      </View>
    </View>
  );
}
