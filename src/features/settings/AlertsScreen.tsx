import { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import type { AlertStyle } from '@/core/alerts/types';
import { createSettingsRepo } from '@/data/db/settings';
import { useDb } from '@/data/queries/context';
import { isBusyStatus } from '@/drive/policy';
import { useDrive } from '@/drive/useDrive';
import { Banner, Button, Card, Divider, Screen, Text, ToggleRow, useTheme } from '@/ui';

import { alertStyleCopy } from './alerts/copy';
import {
  ALERT_STYLES,
  alertStylePref,
  loadAlertStylePref,
  setAlertStylePref,
  subscribeAlertStylePref,
} from './alerts/stylePref';
import { playTestAlert, type TestAlertOutcome } from './alerts/testAlert';
import { loadVoicePref, setVoicePref, subscribeVoicePref, voicePrefEnabled } from './alerts/voicePref';
import { settingsCopy } from './copy';
import { TopBar } from './parts';

const copy = settingsCopy.alerts;

/**
 * `/settings/alerts`: voice alerts on or off (`alerts.voice`, off by default), how alerts reach
 * the driver (sound, vibration or both), and a test alert. Alerts themselves are never switched
 * off here: safety alerts are not a preference, only how they arrive. The test plays only while no
 * drive is recording, so it can never talk over a real alert.
 */
export function AlertsScreen({ deps = {} }: { deps?: { play?: () => Promise<TestAlertOutcome> } }) {
  const th = useTheme();
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const busy = useDrive((s) => isBusyStatus(s.status));
  const [voice, setVoice] = useState(voicePrefEnabled);
  const [style, setStyle] = useState(alertStylePref);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testFailed, setTestFailed] = useState(false);

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

  return (
    <Screen scroll testID="alerts-screen">
      <TopBar title={copy.title} />
      {saveFailed ? <Banner testID="alerts-save-error" tone="warning" message={copy.saveError} /> : null}
      <Card padded={false}>
        <ToggleRow
          title={copy.voice.title}
          subtitle={voice ? copy.voice.on : copy.voice.off}
          value={voice}
          disabled={saving}
          onValueChange={(next) => void save(() => setVoicePref(settings, next))}
          testID="alerts-voice"
        />
        <Divider inset={th.space.lg} />
        <Text variant="footnote" tone="muted" style={{ padding: th.space.lg }} testID="alerts-tones-stay">
          {copy.tonesStay}
        </Text>
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
                  minHeight: th.size.touch,
                  paddingVertical: th.space.sm,
                  paddingHorizontal: th.space.lg,
                  backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
                })}
              >
                <View
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 11,
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
          icon="play"
          variant="secondary"
          onPress={() => void onTest()}
          loading={testing}
          disabled={busy}
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
