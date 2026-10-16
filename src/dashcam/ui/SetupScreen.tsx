import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Platform, View } from 'react-native';

import type { PermissionsAdapter } from '@/core/permissions';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { TopBar } from '@/features/settings/parts';
import { Banner, Button, Card, Screen, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../copy';
import { dashpalSecrets, type DashpalSecrets } from '../secure';
import { createSetupFlow, type SetupDeps, type SetupFailure, type SetupFlow, type SetupPhase } from '../setup';
import { CodeEntry } from './CodeEntry';
import { CodeScanner } from './CodeScanner';
import type { SetupTarget } from './links';
import { useDashcamRuntime } from './useDashcam';
import { useDriveBusy } from './useDriveBusy';

const copy = dashpalCopy.setup;

/** How long "That's not a DashPal code." stays before the same scan may say it again. */
export const REJECT_MS = 2500;

export interface SetupPanelDeps {
  adapter?: PermissionsAdapter;
  platform?: 'ios' | 'android';
  flow?: (base: SetupDeps) => SetupFlow;
  secrets?: DashpalSecrets;
  now?: () => number;
}

/**
 * `/settings/dashcam-setup`: the DashPal setup flow (`../setup.ts`), from Settings, the nearby prompt
 * (`found`), a label link opened with the phone's own camera (`link`: its code waits in SecureStore)
 * or Set up again (`again`). Refuses while a drive is open; Bluetooth is asked here, on this
 * explicit action only, and the camera when the scanner opens.
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

function failureText(reason: SetupFailure, name: string | null): string {
  switch (reason) {
    case 'not_found':
      return copy.notFound(name);
    case 'window_timeout':
      return copy.windowTimeout;
    case 'setup_busy':
      return copy.busyElsewhere;
    case 'wrong_code':
      return copy.wrongCode;
    case 'no_match':
      return copy.noMatch;
    case 'unverified':
      return copy.unverified;
    case 'unverified_nearby':
      return copy.unverifiedNearby;
    case 'no_key':
      return copy.noKey;
    case 'update_firmware':
      return copy.updateFirmware;
    case 'mtu':
      return copy.mtu;
    case 'ios_forget_first':
      return copy.iosForgetFirst;
    case 'error':
      return copy.failed;
  }
}

/**
 * The setup flow's body, also shown inline by the onboarding step (onboarding cannot leave its own
 * routes). `onClose`: Done / Cancel; `onPhase`: the step follows the outcome.
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
  const platform = deps.platform ?? (Platform.OS === 'ios' ? 'ios' : 'android');
  const now = deps.now ?? Date.now;
  const [phase, setPhase] = useState<SetupPhase>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const [typing, setTyping] = useState(false);
  const [rejected, setRejected] = useState<'not_a_code' | 'bad_code' | null>(null);
  const lastReject = useRef(0);
  const { found, link, again } = target;

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
      resumePaired: async () => runtime?.resumePaired(),
      secrets: deps.secrets ?? dashpalSecrets,
      notePhones: (dashcamId, phones) => runtime?.notePhones(dashcamId, phones),
      now,
      sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    };
    return (deps.flow ?? createSetupFlow)(base);
    // The flow starts over only on Try again or a new runtime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, deps.adapter, deps.flow, deps.secrets, platform, runtime, isBusy]);

  useEffect(() => {
    const off = flow.subscribe((p) => {
      setPhase(p);
      onPhase?.(p);
      if (p.kind === 'code' && p.error) {
        // A refused scan says so at most once per 2.5 s (the camera keeps reading); a typed one always.
        const t = now();
        if (p.error === 'bad_code' || t - lastReject.current > REJECT_MS) {
          lastReject.current = t;
          setRejected(p.error);
        }
      }
    });
    void flow.start({
      ...(found ? { preferId: found } : {}),
      ...(link !== undefined ? { fromLink: { dashcamId: link } } : {}),
      ...(again ? { again: true } : {}),
    });
    return () => {
      off();
      void flow.cancel();
    };
    // `onPhase` is read live through the subscription; a new one does not restart the flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow]);

  const retry = () => {
    setRejected(null);
    setTyping(false);
    setAttempt((n) => n + 1);
  };
  const close = onClose;
  const openSettings = () => void (deps.adapter ?? defaultPermissionsAdapter()).openAppSettings().catch(() => {});

  let body: string | null = null;
  let extra: string | null = null;
  let actions: { label: string; onPress: () => void; variant?: 'primary' | 'secondary' | 'ghost'; testID: string }[] = [];
  let working = false;
  switch (phase.kind) {
    case 'busy':
      body = copy.busy;
      actions = [{ label: copy.doneButton, onPress: close, testID: 'setup-close' }];
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
        { label: copy.tryAgain, onPress: retry, variant: 'secondary', testID: 'setup-retry' },
      ];
      break;
    case 'off':
      body = copy.off;
      actions = [{ label: copy.tryAgain, onPress: retry, testID: 'setup-retry' }];
      break;
    case 'unavailable':
      body = copy.unavailable;
      actions = [{ label: copy.doneButton, onPress: close, testID: 'setup-close' }];
      break;
    case 'code':
      working = true;
      break;
    case 'confirm_link':
      body = copy.pairTitle(phase.name);
      actions = [{ label: copy.pair, onPress: () => flow.confirm(), testID: 'setup-pair' }];
      working = true;
      break;
    case 'confirm_replace':
      body = copy.replaceTitle(phase.from, phase.to);
      extra = copy.replaceBody(phase.from);
      actions = [{ label: copy.replace, onPress: () => flow.confirmReplace(), testID: 'setup-replace' }];
      working = true;
      break;
    case 'searching':
      body = phase.again && phase.name ? copy.again(phase.name) : copy.searching(phase.name);
      working = true;
      break;
    case 'connecting':
      body = phase.again ? copy.again(phase.name) : copy.connecting(phase.name);
      working = true;
      break;
    case 'pairing':
    case 'finishing':
      body = phase.again ? copy.again(phase.name) : copy.pairing;
      working = true;
      break;
    case 'press_button':
      body = copy.pressButton;
      working = true;
      break;
    case 'waiting_busy':
      body = copy.waitingBusy;
      working = true;
      break;
    case 'done':
      body = copy.done(phase.paired.name);
      actions = [{ label: copy.doneButton, onPress: close, testID: 'setup-done' }];
      break;
    case 'failed':
      body = failureText(phase.reason, phase.name);
      if (phase.reason === 'not_found' && phase.name) extra = copy.notFoundTwoPhones;
      actions = [{ label: copy.tryAgain, onPress: retry, testID: 'setup-retry' }];
      break;
    case 'cancelled':
      body = copy.failed;
      actions = [{ label: copy.tryAgain, onPress: retry, testID: 'setup-retry' }];
      break;
  }

  return (
    <View style={{ gap: th.space.lg }} testID="dashcam-setup-panel">
      {phase.kind === 'code' ? (
        <View style={{ gap: th.space.md }} testID="setup-phase-code">
          {phase.noStoredCode ? <Banner tone="info" message={copy.noStoredCode} testID="setup-no-stored-code" /> : null}
          {rejected ? <Banner tone="warning" message={rejected === 'bad_code' ? copy.badCode : copy.notACode} testID={`setup-rejected-${rejected}`} /> : null}
          {typing ? (
            <CodeEntry
              onSubmit={(code, name) => {
                setRejected(null);
                flow.submitCode(code, name);
              }}
            />
          ) : (
            <CodeScanner onScanned={(text) => flow.scanned(text)} adapter={deps.adapter} />
          )}
          <Button
            label={typing ? copy.scanInstead : copy.typeInstead}
            variant="ghost"
            onPress={() => {
              setRejected(null);
              setTyping((v) => !v);
            }}
            testID={typing ? 'setup-scan-instead' : 'setup-type-instead'}
          />
          <Text variant="footnote" tone="muted" testID="setup-lost-phone">
            {copy.lostPhone}
          </Text>
        </View>
      ) : (
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
              {copy.donePhones(phase.phones)}
            </Text>
          ) : null}
        </Card>
      )}
      {phase.kind === 'done' && phase.notAllYours ? <Banner tone="warning" message={copy.notAllYours} testID="setup-not-all-yours" /> : null}
      <View style={{ gap: th.space.sm }}>
        {actions.map((a) => (
          <Button key={a.testID} label={a.label} variant={a.variant ?? 'primary'} onPress={a.onPress} testID={a.testID} />
        ))}
        {working ? <Button label={copy.cancel} variant="ghost" onPress={close} testID="setup-cancel" /> : null}
      </View>
    </View>
  );
}
