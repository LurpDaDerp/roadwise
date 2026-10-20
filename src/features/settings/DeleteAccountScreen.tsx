import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, TextInput, useWindowDimensions, View } from 'react-native';

import { useDb } from '@/data/queries/context';
import { useSession } from '@/data/supabase/session';
import { isBusyStatus } from '@/drive/policy';
import { useDrive } from '@/drive/useDrive';
import { Banner, Button, Card, Screen, Text, useTheme } from '@/ui';

import { deleteMyAccount, runAccountDeletion, type DeleteResult } from './api';
import { settingsCopy } from './copy';
import { wipeThisPhone } from './deviceWipe';
import { ExportMessage, useExport, type ExportDeps } from './exportFlow';
import { TopBar } from './parts';

const copy = settingsCopy.deleteAccount;

export interface DeleteAccountDeps extends ExportDeps {
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
  const db = useDb();
  const { signOut } = useSession();
  const busy = useDrive((s) => isBusyStatus(s.status));
  const exporter = useExport(deps);
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const [typed, setTyped] = useState('');
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<Exclude<DeleteResult, { ok: true }>['reason'] | null>(null);
  const confirmed = typed.trim() === copy.confirmWord;

  // Typing DELETE: the page lifts above the keyboard (the button with it) and scrolls the field
  // into view once the keyboard is up.
  const scroll = useRef<ScrollView>(null);
  const typing = useRef(false);
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidShow', () => {
      if (typing.current) scroll.current?.scrollToEnd({ animated: true });
    });
    return () => sub.remove();
  }, []);

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
      <TopBar title={copy.title} />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }} testID="delete-keyboard-avoider">
        <ScrollView
          ref={scroll}
          style={{ flex: 1 }}
          contentContainerStyle={{ gap: th.space.lg }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          testID="delete-scroll"
        >
          <Text variant="title2" accessibilityRole="header">
            {copy.heading}
          </Text>
          <Card testID="delete-consequences">
            <Text variant="headline" accessibilityRole="header">
              {copy.consequencesLabel}
            </Text>
            {copy.consequences.map((line) => (
              <View key={line} style={{ flexDirection: 'row', gap: th.space.sm, alignItems: 'flex-start' }}>
                <Ionicons name="close-circle-outline" size={th.size.icon} color={th.colors.danger} accessibilityElementsHidden importantForAccessibility="no" />
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
              label={exporter.state === 'working' ? settingsCopy.account.export.working : copy.exportAction}
              variant="secondary"
              size="md"
              onPress={() => void exporter.run()}
              loading={exporter.state === 'working'}
            />
            <ExportMessage state={exporter.state} />
          </View>
          <Text variant="subhead" tone="danger" testID="delete-cannot-undo">
            {copy.cannotUndo}
          </Text>
          <View style={{ gap: th.space.xs }}>
            <Text variant="headline">{copy.typeLabel}</Text>
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
              onFocus={() => {
                typing.current = true;
              }}
              onBlur={() => {
                typing.current = false;
              }}
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
      </KeyboardAvoidingView>
    </Screen>
  );
}
