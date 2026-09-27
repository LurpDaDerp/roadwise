import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';
import { isBusyStatus } from '@/drive/policy';
import { useDrive } from '@/drive/useDrive';
import { TOUCH } from '@/features/trips/layout';
import { TripTopBar } from '@/features/trips/TopBar';
import { Banner, Button, Card, Screen, Text, useTheme } from '@/ui';

import { loadVoicePref, setVoicePref, subscribeVoicePref, voicePrefEnabled } from './alerts/voicePref';
import { playTestAlert, type TestAlertOutcome } from './alerts/testAlert';
import { settingsCopy } from './copy';

const copy = settingsCopy.alerts;

/**
 * H4 · Alerts and sounds, lean: voice prompts on or off, and a test alert. The tones and the
 * vibration are never switched off here (§13.4: safety sounds are not a preference), and the screen
 * says so. The test plays only while no drive is recording, so it can never talk over a real alert.
 */
export function AlertsScreen({ deps = {} }: { deps?: { play?: () => Promise<TestAlertOutcome> } }) {
  const th = useTheme();
  const router = useRouter();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const busy = useDrive((s) => isBusyStatus(s.status));
  const [voice, setVoice] = useState(voicePrefEnabled);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testFailed, setTestFailed] = useState(false);
  const back = router.canGoBack() ? () => router.back() : null;

  useEffect(() => {
    let live = true;
    void loadVoicePref(settings).then((on) => {
      if (live) setVoice(on);
    });
    const off = subscribeVoicePref((on) => setVoice(on));
    return () => {
      live = false;
      off();
    };
  }, [settings]);

  const onVoice = async (next: boolean) => {
    setSaving(true);
    setSaveFailed(false);
    try {
      await setVoicePref(settings, next);
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const onTest = async () => {
    if (testing || busy) return;
    setTesting(true);
    setTestFailed(false);
    const outcome = await (deps.play ?? playTestAlert)();
    setTesting(false);
    setTestFailed(outcome === 'failed');
  };

  const hint = voice ? copy.voice.on : copy.voice.off;
  return (
    <Screen scroll testID="alerts-screen">
      <TripTopBar title={copy.title} onBack={back} />
      {saveFailed ? <Banner testID="alerts-save-error" tone="warning" message={copy.saveError} /> : null}
      <Card padded={false}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: th.space.md,
            paddingVertical: th.space.md,
            paddingHorizontal: th.space.lg,
            minHeight: TOUCH + th.space.md,
          }}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text variant="headline">{copy.voice.title}</Text>
            <Text variant="footnote" tone="muted" testID="alerts-voice-hint">
              {hint}
            </Text>
          </View>
          <Switch
            testID="alerts-voice"
            accessibilityRole="switch"
            accessibilityLabel={copy.voice.title}
            accessibilityHint={hint}
            accessibilityState={{ checked: voice, disabled: saving }}
            value={voice}
            disabled={saving}
            onValueChange={(next) => void onVoice(next)}
            trackColor={{ true: th.colors.accent, false: th.colors.border }}
          />
        </View>
        <View style={{ borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: th.colors.divider, padding: th.space.lg }}>
          <Text variant="footnote" tone="muted" testID="alerts-tones-stay">
            {copy.tonesStay}
          </Text>
        </View>
      </Card>

      <View style={{ gap: th.space.sm }}>
        <Button
          testID="alerts-test"
          label={testing ? copy.test.playing : copy.test.label}
          variant="secondary"
          onPress={() => void onTest()}
          loading={testing}
          disabled={busy}
          accessibilityHint={busy ? copy.test.busy : copy.test.hint}
        />
        {busy ? (
          <Text variant="footnote" tone="muted" testID="alerts-test-busy">
            {copy.test.busy}
          </Text>
        ) : null}
        {testFailed ? <Banner testID="alerts-test-failed" tone="warning" message={copy.test.failed} /> : null}
      </View>
    </Screen>
  );
}
