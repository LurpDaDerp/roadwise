import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, TextInput, useWindowDimensions, View } from 'react-native';

import { useDb } from '@/data/queries';
import { useSession } from '@/data/supabase/session';
import { isBusyStatus } from '@/drive/policy';
import { useDrive } from '@/drive/useDrive';
import { ICON } from '@/features/trips/layout';
import { TripTopBar } from '@/features/trips/TopBar';
import { Banner, Button, Card, Screen, Text, useTheme } from '@/ui';

import { deleteMyAccount, runAccountDeletion, type DeleteResult } from './api';
import { settingsCopy } from './copy';
import { wipeThisPhone } from './deviceWipe';
import { FieldLabel } from './parts';
import { ExportMessage, useExport, type PrivacyDeps } from './PrivacyScreen';

const copy = settingsCopy.deleteAccount;

export interface DeleteAccountDeps extends PrivacyDeps {
  remove?: () => Promise<DeleteResult>;
  wipe?: () => Promise<void>;
}

/**
 * H13 · Delete account: the consequences first, the optional export, then the confirmation. The
 * button is live only once DELETE is typed, and never while a drive is recording (the drive must
 * end, and upload, under the account it belongs to). Deleted: the server has removed everything,
 * this phone signs out and is emptied, and the auth change moves the app to the welcome screen.
 */
export function DeleteAccountScreen({ deps = {} }: { deps?: DeleteAccountDeps }) {
  const th = useTheme();
  const router = useRouter();
  const db = useDb();
  const { signOut } = useSession();
  const busy = useDrive((s) => isBusyStatus(s.status));
  const exporter = useExport(deps);
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<Exclude<DeleteResult, { ok: true }>['reason'] | null>(null);
  const back = router.canGoBack() ? () => router.back() : null;
  const confirmed = typed.trim() === copy.confirmWord;

  const onDelete = async () => {
    if (!confirmed || busy || working) return;
    setWorking(true);
    setFailure(null);
    const result = await runAccountDeletion({
      remove: deps.remove ?? (() => deleteMyAccount(deps.account)),
      signOut: () => signOut({ force: true }),
      wipe: deps.wipe ?? (() => wipeThisPhone(db)),
    });
    // Deleted or signed out, the session is over and the gate is already moving the app on.
    setWorking(false);
    if (!result.ok) setFailure(result.reason);
  };

  return (
    <Screen testID="delete-account-screen">
      <TripTopBar title={copy.title} onBack={back} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: th.space.lg }} showsVerticalScrollIndicator={false}>
        <Text variant="title2" accessibilityRole="header">
          {copy.heading}
        </Text>
        <Card testID="delete-consequences">
          <FieldLabel>{copy.consequencesLabel}</FieldLabel>
          {copy.consequences.map((line) => (
            <View key={line} style={{ flexDirection: 'row', gap: th.space.sm, alignItems: 'flex-start' }}>
              <Ionicons name="close-circle-outline" size={ICON.md} color={th.colors.danger} accessibilityElementsHidden importantForAccessibility="no" />
              <Text variant="body" style={{ flex: 1 }}>
                {line}
              </Text>
            </View>
          ))}
        </Card>
        <View style={{ gap: th.space.sm }}>
          <Text variant="subhead">{copy.exportFirst}</Text>
          <Button
            testID="delete-export"
            label={exporter.state === 'working' ? settingsCopy.privacy.export.working : copy.exportAction}
            variant="secondary"
            size="md"
            onPress={() => void exporter.run()}
            loading={exporter.state === 'working'}
            accessibilityHint={settingsCopy.privacy.export.hint}
          />
          <ExportMessage state={exporter.state} />
        </View>
        <Text variant="subhead" tone="danger" testID="delete-cannot-undo">
          {copy.cannotUndo}
        </Text>
        <View style={{ gap: th.space.xs }}>
          <FieldLabel>{copy.typeLabel}</FieldLabel>
          <TextInput
            testID="delete-confirm-input"
            accessibilityLabel={copy.typeLabel}
            accessibilityHint={copy.typeHint}
            value={typed}
            onChangeText={setTyped}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            selectionColor={th.colors.danger}
            cursorColor={th.colors.danger}
            allowFontScaling={false}
            editable={!working}
            style={{
              minHeight: 48 * scale,
              borderWidth: 1.5,
              borderColor: confirmed ? th.colors.danger : th.colors.borderStrong,
              borderRadius: th.radius.md,
              paddingHorizontal: th.space.md,
              backgroundColor: th.colors.surface,
              color: th.colors.text,
              fontSize: 17 * scale,
            }}
          />
        </View>
        {busy ? <Banner testID="delete-busy" tone="info" message={copy.busy} /> : null}
        {failure === 'offline' ? <Banner testID="delete-offline" tone="info" message={copy.offline} /> : null}
        {failure === 'failed' ? <Banner testID="delete-failed" tone="danger" message={copy.failed} /> : null}
        {failure === 'session_gone' ? <Banner testID="delete-session-gone" tone="info" message={copy.sessionGone} /> : null}
      </ScrollView>
      <View style={{ paddingTop: th.space.md }}>
        <Button
          testID="delete-confirm"
          label={working ? copy.working : copy.action}
          variant="destructive"
          onPress={() => void onDelete()}
          loading={working}
          disabled={!confirmed || busy}
          accessibilityHint={copy.actionHint}
        />
      </View>
    </Screen>
  );
}
