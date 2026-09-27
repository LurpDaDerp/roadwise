// `/settings/camera`: the camera beta's switch, the driver's seat side, and the consent text it rests on. No
// calibration: the camera learns where the road is by itself as you drive. Lane C's Settings root links here.
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, Switch, View } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { StatusLine } from '@/features/onboarding/steps/permissionKit';
import { TOUCH } from '@/features/trips/layout';
import { TripTopBar } from '@/features/trips/TopBar';
import { Screen, Text, useTheme } from '@/ui';

import { DRIVER_SIDE_KEY } from './bridge';
import { CameraConsent } from './CameraConsent';
import { cameraCopy } from './copy';
import { useCameraBeta, type CameraBetaDeps } from './useCameraBeta';

const copy = cameraCopy.settings;

export function CameraSettingsScreen({ deps }: { deps?: CameraBetaDeps }) {
  const th = useTheme();
  const router = useRouter();
  const { profile } = useSession();
  const beta = useCameraBeta(profile?.age_band ?? null, deps);
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const [side, setSide] = useState<'left' | 'right'>('left');
  useEffect(() => {
    void settings
      .get<unknown>(DRIVER_SIDE_KEY)
      .then((v) => setSide(v === 'right' ? 'right' : 'left'))
      .catch(() => {});
  }, [settings]);
  const chooseSide = (s: 'left' | 'right') => {
    setSide(s);
    void settings.set(DRIVER_SIDE_KEY, s).catch(() => {});
  };
  const back = router.canGoBack() ? () => router.back() : null;
  const on = beta.on === true;

  return (
    <Screen scroll testID="camera-settings">
      <TripTopBar title={copy.title} onBack={back} />
      <View style={{ gap: th.space.lg }}>
        {beta.eligibility === 'age' ? <StatusLine tone="info">{cameraCopy.step.notAvailableAge}</StatusLine> : null}
        {beta.eligibility === 'flag_off' ? <StatusLine tone="info">{cameraCopy.step.notAvailableFlag}</StatusLine> : null}
        {beta.eligibility === 'ok' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md, minHeight: TOUCH }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text variant="headline">{copy.switchLabel}</Text>
              <Text variant="footnote" tone="muted">
                {copy.switchHint}
              </Text>
            </View>
            <Switch
              testID="camera-switch"
              accessibilityRole="switch"
              accessibilityLabel={copy.switchLabel}
              accessibilityHint={copy.switchHint}
              accessibilityState={{ checked: on, disabled: beta.busy || beta.on === null }}
              value={on}
              disabled={beta.busy || beta.on === null}
              onValueChange={(v) => void (v ? beta.turnOn() : beta.turnOff())}
              trackColor={{ true: th.colors.accent, false: th.colors.border }}
            />
          </View>
        ) : null}
        {beta.eligibility === 'ok' && beta.on !== null ? (
          <Text variant="callout" tone="muted" testID="camera-state">
            {on ? `${copy.onNote} ${copy.permissionNote}` : copy.offNote}
          </Text>
        ) : null}
        {beta.failed ? <StatusLine tone="off">{copy.failed}</StatusLine> : null}
        {beta.eligibility === 'ok' && on ? (
          <View style={{ gap: th.space.sm }}>
            <Text variant="headline">{copy.seatLabel}</Text>
            <Text variant="footnote" tone="muted">
              {copy.seatHint}
            </Text>
            <View style={{ flexDirection: 'row', gap: th.space.sm }} accessibilityRole="radiogroup">
              {(['left', 'right'] as const).map((s) => (
                <Pressable
                  key={s}
                  testID={`camera-seat-${s}`}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: side === s }}
                  onPress={() => chooseSide(s)}
                  style={{
                    flex: 1,
                    minHeight: TOUCH,
                    alignItems: 'center',
                    justifyContent: 'center',
                    borderRadius: th.radius.md,
                    borderWidth: 1,
                    borderColor: side === s ? th.colors.accent : th.colors.border,
                    backgroundColor: side === s ? th.colors.surfaceRaised : th.colors.surface,
                  }}
                >
                  <Text variant="headline">{s === 'left' ? copy.seatLeft : copy.seatRight}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}
        {beta.eligibility === 'ok' ? (
          <View style={{ gap: th.space.sm }}>
            <Text variant="headline" accessibilityRole="header">
              {copy.whatItDoes}
            </Text>
            <CameraConsent testID="camera-settings-consent" />
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
