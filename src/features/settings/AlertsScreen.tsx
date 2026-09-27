import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';

import type { AlertStyle } from '@/core/alerts/types';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries';
import { isBusyStatus } from '@/drive/policy';
import { useDrive } from '@/drive/useDrive';
import { TOUCH } from '@/features/trips/layout';
import { TripTopBar } from '@/features/trips/TopBar';
import { Banner, Button, Card, Screen, Text, useTheme } from '@/ui';

import { alertStyleCopy } from './alerts/copy';
import {
  ALERT_STYLES,
  alertStylePref,
  loadAlertStylePref,
  setAlertStylePref,
  subscribeAlertStylePref,
} from './alerts/stylePref';
import { loadVoicePref, setVoicePref, subscribeVoicePref, voicePrefEnabled } from './alerts/voicePref';
import { playTestAlert, type TestAlertOutcome } from './alerts/testAlert';
import { settingsCopy } from './copy';

const copy = settingsCopy.alerts;

/**
 * H4 · Alerts and sounds, lean: voice prompts on or off, the alert style (sound and vibration,
 * vibration only, sound only), and a test alert. Alerts are never switched off altogether here
 * (§13.4: safety alerts are not a preference) — only how they reach the driver. The test plays only
 * while no drive is recording, so it can never talk over a real alert, and plays in the chosen style.
 */
export function AlertsScreen({ deps = {} }: { deps?: { play?: () => Promise<TestAlertOutcome> } }) {
  const th = useTheme();
  const router = useRouter();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const busy = useDrive((s) => isBusyStatus(s.status));
  const [voice, setVoice] = useState(voicePrefEnabled);
  const [style, setStyle] = useState(alertStylePref);
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
    void loadAlertStylePref(settings).then((s) => {
      if (live) setStyle(s);
    });
    const offVoice = subscribeVoicePref((on) => setVoice(on));
    const offStyle = subscribeAlertStylePref((s) => setStyle(s));
    return () => {
      live = false;
      offVoice();
      offStyle();
    };
  }, [settings]);

  const save = async (write: () => Promise<void>) => {
    setSaving(true);
    setSaveFailed(false);
    try {
      await write();
    } catch {
      setSaveFailed(true);
    } finally {
      setSaving(false);
    }
  };
  const onVoice = (next: boolean) => save(() => setVoicePref(settings, next));
  const onStyle = (next: AlertStyle) => {
    if (next !== style) void save(() => setAlertStylePref(settings, next));
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

      <Card padded={false}>
        <View style={{ gap: 2, paddingTop: th.space.md, paddingHorizontal: th.space.lg }}>
          <Text variant="headline">{alertStyleCopy.title}</Text>
          <Text variant="footnote" tone="muted">
            {alertStyleCopy.hint}
          </Text>
        </View>
        <View accessibilityRole="radiogroup" style={{ paddingVertical: th.space.sm }}>
          {ALERT_STYLES.map((s) => {
            const chosen = s === style;
            return (
              <Pressable
                key={s}
                testID={`alerts-style-${s}`}
                accessibilityRole="radio"
                accessibilityLabel={alertStyleCopy.options[s]}
                accessibilityState={{ checked: chosen, disabled: saving }}
                disabled={saving}
                onPress={() => onStyle(s)}
                style={({ pressed }) => ({
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: th.space.md,
                  minHeight: TOUCH,
                  paddingVertical: th.space.sm,
                  paddingHorizontal: th.space.lg,
                  opacity: pressed ? 0.7 : 1,
                })}
              >
                <View
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    borderWidth: 2,
                    borderColor: chosen ? th.colors.accent : th.colors.borderStrong,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {chosen ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: th.colors.accent }} /> : null}
                </View>
                <Text variant="body">{alertStyleCopy.options[s]}</Text>
              </Pressable>
            );
          })}
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
