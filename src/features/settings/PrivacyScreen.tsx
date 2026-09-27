import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Platform, View } from 'react-native';

import { TripTopBar } from '@/features/trips/TopBar';
import { Banner, Button, Card, Screen, Text, useTheme } from '@/ui';

import { exportMyData, type AccountDeps, type ExportResult } from './api';
import { settingsCopy } from './copy';
import { shareExport, type ExportShareOutcome } from './exportShare';
import { FieldLabel } from './parts';
import { SETTINGS_HREFS } from './routes';

const copy = settingsCopy.privacy;

export interface PrivacyDeps {
  account?: AccountDeps;
  exportData?: () => Promise<ExportResult>;
  share?: (json: string) => Promise<ExportShareOutcome>;
  platform?: string;
}

type ExportState = 'idle' | 'working' | 'saved' | 'offline' | 'too_many' | 'failed';

/** Exports, then hands the file to the sheet; the state the screen shows after. */
export function useExport(deps: PrivacyDeps = {}) {
  const [state, setState] = useState<ExportState>('idle');
  const run = async () => {
    if (state === 'working') return;
    setState('working');
    const r = await (deps.exportData ?? (() => exportMyData(deps.account)))();
    if (!r.ok) {
      setState(r.reason);
      return;
    }
    const outcome = await (deps.share ?? ((json: string) => shareExport(json)))(r.json);
    setState(outcome === 'failed' ? 'failed' : outcome === 'saved' ? 'saved' : 'idle');
  };
  return { state, run };
}

export function ExportMessage({ state }: { state: ExportState }) {
  if (state === 'saved') return <Banner testID="export-saved" tone="info" message={copy.export.saved} />;
  if (state === 'offline') return <Banner testID="export-offline" tone="info" message={copy.export.offline} />;
  if (state === 'too_many') return <Banner testID="export-too-many" tone="warning" message={copy.export.tooMany} />;
  if (state === 'failed') return <Banner testID="export-failed" tone="warning" message={copy.export.failed} />;
  return null;
}

/**
 * H7 · Privacy and data, lean: what RoadWise keeps, a copy of it (H14), and the way out (H13).
 * Export is one tap to the share sheet; deleting the account opens its own screen, which states the
 * consequences before the control.
 */
export function PrivacyScreen({ deps = {} }: { deps?: PrivacyDeps }) {
  const th = useTheme();
  const router = useRouter();
  const exporter = useExport(deps);
  const android = (deps.platform ?? Platform.OS) === 'android';
  const back = router.canGoBack() ? () => router.back() : null;

  return (
    <Screen scroll testID="privacy-screen">
      <TripTopBar title={copy.title} onBack={back} />
      <Text variant="body" testID="privacy-what">
        {copy.what}
      </Text>

      <View style={{ gap: th.space.sm }}>
        <FieldLabel>{copy.export.title}</FieldLabel>
        <Card testID="privacy-export">
          <Text variant="body">{copy.export.body}</Text>
          {android ? (
            <Text variant="footnote" tone="muted" testID="privacy-export-android">
              {copy.export.androidNote}
            </Text>
          ) : null}
          <Button
            testID="privacy-export-button"
            label={exporter.state === 'working' ? copy.export.working : copy.export.action}
            variant="secondary"
            onPress={() => void exporter.run()}
            loading={exporter.state === 'working'}
            accessibilityHint={copy.export.hint}
          />
        </Card>
        <ExportMessage state={exporter.state} />
      </View>

      <View style={{ gap: th.space.sm }}>
        <FieldLabel>{copy.delete.title}</FieldLabel>
        <Card testID="privacy-delete">
          <Text variant="body">{copy.delete.body}</Text>
          <Button
            testID="privacy-delete-button"
            label={copy.delete.action}
            variant="ghost"
            onPress={() => router.push(SETTINGS_HREFS.deleteAccount)}
            accessibilityHint={copy.delete.hint}
          />
        </Card>
      </View>
    </Screen>
  );
}
