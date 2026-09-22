import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

import {
  DISCLOSURE_AFFIRMED_KEY,
  MANUAL_BY_CHOICE_KEY,
  recordPrompt,
  type PermissionSnapshot,
} from '@/core/permissions';
import { BackgroundDisclosure } from '@/features/permissions/BackgroundDisclosure';
import { markSettingsReturn } from '@/features/permissions/usePermissionHealth';
import { Banner, Card, Screen, Skeleton, Text, useTheme } from '@/ui';

import { onboardingCopy } from '../copy';
import type { StepProps } from '../stepRegistry';
import { StepFrame, type StepAction } from '../StepFrame';
import {
  StatusLine,
  useGrantConsent,
  usePhone,
  useStepDeps,
  type PermissionStepDeps,
} from './permissionKit';

const copy = onboardingCopy.location;

const granted = (s: PermissionSnapshot | null) => s?.location === 'foreground' || s?.location === 'always';

type View_ = 'loading' | 'error' | 'ask' | 'denied' | 'disclosure' | 'approximate' | 'granted';

/**
 * A6 · Location. One OS prompt: *While Using*, on the driver's tap (rev1: m).
 *
 * - **Android:** straight after a foreground grant the one prominent disclosure takes the screen
 *   (`BackgroundDisclosure reason="onboarding"`); Always is asked only after its Continue, and
 *   Not now there is manual by choice. It is shown again on a return to this step only if it was
 *   never answered.
 * - **iOS:** no background request at all (design §5.3). The step says the question comes after
 *   the first drive, and asks nothing more.
 * - A grant records the `location` consent (approximate is a grant); a denial records nothing and
 *   the step still moves on (D12). Approximate location is said plainly, with a way to Settings.
 */
export function LocationStep({ ctx, onNext, onBack, deps }: StepProps & { deps?: PermissionStepDeps }) {
  const th = useTheme();
  const { settings, adapter, appState, now } = useStepDeps(deps);
  const phone = usePhone(adapter, appState);
  const grantConsent = useGrantConsent(settings);
  const ios = ctx.platform === 'ios';

  /** The disclosure was answered before (affirmed, or Not now): a resume doesn't show it again. */
  const [disclosureDone, setDisclosureDone] = useState<boolean | null>(null);
  const [answered, setAnswered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leaving = useRef(false);

  useEffect(() => {
    let live = true;
    void Promise.all([settings.get(DISCLOSURE_AFFIRMED_KEY), settings.get(MANUAL_BY_CHOICE_KEY)])
      .then(([affirmed, manual]) => live && setDisclosureDone(affirmed !== null || manual === true))
      .catch(() => live && setDisclosureDone(false));
    return () => {
      live = false;
    };
  }, [settings]);

  const snapshot = phone.status === 'ready' ? phone.snapshot : null;

  let view: View_;
  if (phone.status === 'error') view = 'error';
  else if (snapshot === null || disclosureDone === null) view = 'loading';
  else if (granted(snapshot)) {
    if (!ios && snapshot.location === 'foreground' && !disclosureDone) view = 'disclosure';
    else if (snapshot.precise === false) view = 'approximate';
    else view = 'granted';
  } else if (snapshot.location === 'denied' && (answered || !snapshot.locationCanAskAgain)) view = 'denied';
  else view = 'ask';

  /** Move on: a location that is on now is a grant, and its consent goes with it. */
  const leave = async (s: PermissionSnapshot | null = snapshot) => {
    if (leaving.current) return;
    leaving.current = true;
    if (granted(s)) await grantConsent('location');
    onNext();
  };

  const allow = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const access = await adapter.requestLocationForeground();
      await recordPrompt(settings, 'location', now()).catch(() => {});
      setAnswered(true);
      const next = await phone.reload();
      if (access === 'foreground' || access === 'always') {
        await grantConsent('location');
        // Android With While Using: the disclosure renders next (derived above). Otherwise move
        // on, unless approximate location has something to say first.
        const disclosureNext = !ios && access === 'foreground' && !disclosureDone;
        if (!disclosureNext && next?.precise !== false) await leave(next);
      }
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

  if (view === 'disclosure') {
    return (
      <Screen scroll testID="location-step-disclosure">
        <BackgroundDisclosure
          reason="onboarding"
          deps={{ adapter, appState, now }}
          onResult={() => {
            setDisclosureDone(true);
            void phone.reload().then((s) => {
              // Approximate location still needs saying; anything else moves on.
              if (s?.precise !== false) void leave(s ?? snapshot);
            });
          }}
        />
      </Screen>
    );
  }

  const cont: StepAction = { label: copy.continue, onPress: () => void leave(), testID: 'location-continue' };
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
      secondary = { label: copy.notNow, onPress: () => void leave(), disabled: busy, testID: 'location-not-now' };
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
    case 'granted':
      primary = cont;
      break;
  }

  return (
    <StepFrame title={copy.title} onBack={onBack} primary={primary} secondary={secondary} testID="location-step">
      <View style={{ gap: th.space.lg }}>
        <Card variant="license">
          <Text variant="body">{copy.body}</Text>
          <Text variant="subhead" tone="muted">
            {copy.promise}
          </Text>
        </Card>
        {view === 'loading' ? <Skeleton width="70%" height={20} /> : null}
        {view === 'error' ? (
          <Banner
            tone="warning"
            message={onboardingCopy.autoRecord.loadFailed}
            action={{ label: onboardingCopy.autoRecord.retry, onPress: () => void phone.reload() }}
            testID="location-read-error"
          />
        ) : null}
        {view === 'granted' ? <StatusLine tone="ok">{copy.allowed}</StatusLine> : null}
        {view === 'denied' ? <StatusLine tone="off">{copy.denied}</StatusLine> : null}
        {view === 'approximate' ? <StatusLine tone="attention">{copy.approximate}</StatusLine> : null}
        {/* The question comes from the post-drive offer, which exists only while auto-record does
            (Ruling T9 (3)): with the flag off, nothing is promised about later (T14 review m1). */}
        {ios && ctx.features.autoDetect && (view === 'ask' || view === 'granted') ? (
          <Text variant="subhead" tone="muted" testID="location-ios-later">
            {copy.iosLater}
          </Text>
        ) : null}
        {failed ? (
          <Text variant="callout" tone="danger" accessibilityRole="alert">
            {copy.failed}
          </Text>
        ) : null}
      </View>
    </StepFrame>
  );
}
