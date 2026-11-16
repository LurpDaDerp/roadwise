import { useRef, useState } from 'react';
import { View } from 'react-native';

import { recordPrompt, type PermissionSnapshot } from '@/core/permissions';
import { useBackgroundDisclosure } from '@/features/permissions/BackgroundDisclosure';
import { locationIsBackground } from '@/features/permissions/registry';
import { markSettingsReturn } from '@/features/permissions/usePermissionHealth';
import { Banner, Card, Skeleton, Text, useTheme } from '@/ui';

import { onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame, type StepAction } from '../StepFrame';
import { deviceAndroidApi, StatusLine, usePhone, useStepDeps, type PermissionStepDeps } from './permissionKit';

const all = onboardingCopy.location;

const granted = (s: PermissionSnapshot | null) => s?.location === 'foreground' || s?.location === 'always';

type View_ = 'loading' | 'error' | 'ask' | 'denied' | 'approximate' | 'granted' | 'whileUsing';

/**
 * Location, on the driver's tap. One tap asks twice: While Using, then the upgrade to Always
 * (Android: "Allow all the time") that lets RoadWise notice drives with the app closed; the primer
 * says so first. On Android, Google Play's prominent disclosure for background location shows between
 * the two, and only Continue there makes the second request (the drive detector shows the system's
 * dialog or, on Android 11 and later, its settings page; back from there the phone is read again).
 * Not now keeps While Using, with "Allow all the time" offered again (the disclosure first). Android
 * asks for Always only where the phone has the drive detector (it has answered: `canAskAlways` is not
 * null); without one there are no automatic drives, so While Using is all the step asks. On Android 9
 * and lower with the detector, allowing location allows it in the background too, so the disclosure
 * comes before the one request. A denial still moves on (D12). Approximate location is said plainly,
 * with a way to Settings, and is never asked for Always.
 */
export function LocationStep({ ctx, onNext, onBack, deps, api = deviceAndroidApi() }: StepProps & { deps?: PermissionStepDeps; api?: number | null }) {
  const th = useTheme();
  const { settings, adapter, appState, now } = useStepDeps(deps);
  const phone = usePhone(adapter, appState);
  const disclosure = useBackgroundDisclosure();
  const ios = ctx.platform === 'ios';

  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leaving = useRef(false);

  const snapshot = phone.status === 'ready' ? phone.snapshot : null;
  /** Whether this phone asks for Always: every iPhone, an Android phone with the drive detector. */
  const asksAlways = (s: PermissionSnapshot | null) => ios || (s !== null && s.canAskAlways !== null);
  /** Android 9 and lower with the detector: the location request is a background one too. */
  const oneAsk = (s: PermissionSnapshot | null) => s !== null && locationIsBackground({ snapshot: s, androidApi: api });
  const always = asksAlways(snapshot);

  let view: View_;
  if (phone.status === 'error') view = 'error';
  else if (snapshot === null) view = 'loading';
  else if (granted(snapshot)) {
    if (snapshot.precise === false) view = 'approximate';
    else if (snapshot.location === 'always' || !always) view = 'granted';
    // While Using: offer the Always step until it has been asked (an iPhone asks it only once).
    else view = answered || (ios && snapshot.canAskAlways === false) ? 'whileUsing' : 'ask';
  } else if (snapshot.location === 'denied' && (answered || !snapshot.locationCanAskAgain)) view = 'denied';
  else view = 'ask';

  const leave = () => {
    if (leaving.current) return;
    leaving.current = true;
    onNext();
  };

  /**
   * The second ask, Always. Android shows the background-location disclosure first: Not now asks
   * nothing. Returns the phone's read after it (null when unread or not asked).
   */
  const askAlways = async (): Promise<PermissionSnapshot | null> => {
    if (ios) {
      await adapter.requestLocationAlways();
      return phone.reload();
    }
    if (!(await disclosure.ask())) return null;
    await adapter.requestLocationAlways({ disclosed: true });
    return phone.reload();
  };

  const allow = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      // Android 9 and lower: Google Play's disclosure first (Not now asks nothing; the adapter asks
      // only with it).
      const disclosed = oneAsk(snapshot);
      if (disclosed && !(await disclosure.ask('allow'))) return;
      const access = await adapter.requestLocationForeground({ disclosed });
      await recordPrompt(settings, 'location', now()).catch(() => {});
      let next = await phone.reload();
      const precise = next?.precise !== false;
      const wantsAlways = asksAlways(next ?? snapshot);
      // The second ask: Always, right after While Using.
      if (access === 'foreground' && precise && wantsAlways) next = (await askAlways()) ?? next;
      setAnswered(true);
      // Move on once the phone holds what it needs (Always, or location where it has no detector),
      // unless there is something to say first.
      if (precise && (next?.location === 'always' || (!wantsAlways && granted(next)))) leave();
    } catch {
      setAnswered(true);
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  /** Android, kept at While Using: the disclosure, then "Allow all the time" once more. */
  const allowAlways = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const next = await askAlways();
      if (next?.location === 'always') leave();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const openSettings = async () => {
    setFailed(false);
    try {
      await markSettingsReturn(settings, now());
      await adapter.openAppSettings();
    } catch {
      setFailed(true);
    }
  };

  const copy = ios ? all.ios : all.android;
  const cont: StepAction = { label: copy.continue, onPress: () => leave(), testID: 'location-continue' };
  const settingsAction: StepAction = {
    label: copy.openSettings,
    onPress: () => void openSettings(),
    testID: 'location-settings',
  };

  let primary: StepAction;
  let secondary: StepAction | undefined;
  switch (view) {
    case 'loading':
      primary = { label: copy.allow, onPress: () => {}, disabled: true, testID: 'location-allow' };
      break;
    case 'error':
      primary = cont;
      break;
    case 'ask':
      primary = { label: copy.allow, onPress: () => void allow(), loading: busy, testID: 'location-allow' };
      secondary = { label: copy.notNow, onPress: () => leave(), disabled: busy, testID: 'location-not-now' };
      break;
    case 'denied':
      primary = cont;
      secondary =
        snapshot?.locationCanAskAgain && !answered
          ? { label: copy.allow, onPress: () => void allow(), loading: busy, testID: 'location-allow' }
          : settingsAction;
      break;
    case 'approximate':
      primary = cont;
      secondary = settingsAction;
      break;
    case 'whileUsing':
      primary = cont;
      // Android: never a settings trip around the disclosure; the detector opens the page itself.
      secondary = ios ? settingsAction : { label: all.android.allowAlways, onPress: () => void allowAlways(), loading: busy, testID: 'location-allow-always' };
      break;
    case 'granted':
      primary = cont;
      break;
  }

  return (
    <StepFrame title={copy.title} onBack={onBack} primary={primary} secondary={secondary} testID="location-step">
      <View style={{ gap: th.space.lg }}>
        <Card>
          <Text variant="body">{copy.body}</Text>
          {view === 'ask' && always && !oneAsk(snapshot) ? (
            <Text variant="callout" testID="location-twice">
              {copy.steps}
            </Text>
          ) : null}
          <Text variant="subhead" tone="muted">
            {copy.promise}
          </Text>
        </Card>
        {view === 'loading' ? <Skeleton width="70%" height={20} /> : null}
        {view === 'error' ? (
          <Banner
            tone="warning"
            message={onboardingCopy.permissions.loadFailed}
            action={{ label: onboardingCopy.permissions.retry, onPress: () => void phone.reload() }}
            testID="location-read-error"
          />
        ) : null}
        {view === 'granted' ? <StatusLine tone="ok">{always ? copy.always : all.android.allowed}</StatusLine> : null}
        {view === 'whileUsing' ? <StatusLine tone="attention">{copy.whileUsing}</StatusLine> : null}
        {view === 'denied' ? <StatusLine tone="off">{copy.denied}</StatusLine> : null}
        {view === 'approximate' ? <StatusLine tone="attention">{copy.approximate}</StatusLine> : null}
        {failed ? (
          <Text variant="callout" tone="danger" accessibilityRole="alert">
            {copy.failed}
          </Text>
        ) : null}
      </View>
      {disclosure.sheet}
    </StepFrame>
  );
}
