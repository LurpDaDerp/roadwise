import { useRouter } from 'expo-router';
import { Platform } from 'react-native';

import { useMySummary } from '@/data/server/summary';
import { Avatar, Button, Card, ListRow, Screen, Text, useTheme } from '@/ui';

import { settingsCopy } from './copy';
import { ExportMessage, useExport, type ExportDeps } from './exportFlow';
import { RowIcon, Section, TopBar } from './parts';
import { SETTINGS_HREFS } from './routes';
import { useSignOutFlow } from './useSignOutFlow';

const copy = settingsCopy.account;

/**
 * `/settings/account`: who is signed in, sign out, a copy of your data, and the way out (Apple
 * requires deletion inside the app). Deleting opens its own screen, which says what goes first.
 */
export function AccountScreen({ deps = {} }: { deps?: ExportDeps }) {
  const th = useTheme();
  const router = useRouter();
  const username = useMySummary().data?.profile.username ?? null;
  const exporter = useExport(deps);
  const { signOut, signingOut } = useSignOutFlow();
  const android = (deps.platform ?? Platform.OS) === 'android';

  return (
    <Screen scroll testID="account-screen">
      <TopBar title={copy.title} />
      {username ? (
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.md }}>
          <Avatar username={username} size="lg" />
          <Text variant="headline" style={{ flex: 1 }} testID="account-username">
            {copy.signedInAs(username)}
          </Text>
        </Card>
      ) : null}

      <Section title={copy.export.title} footer={android ? copy.export.androidNote : undefined}>
        <ListRow
          title={exporter.state === 'working' ? copy.export.working : copy.export.action}
          subtitle={copy.export.body}
          leading={<RowIcon name="download-outline" />}
          onPress={() => void exporter.run()}
          testID="account-export"
        />
      </Section>
      <ExportMessage state={exporter.state} />

      <Section title={copy.delete.title}>
        <ListRow
          title={copy.delete.title}
          subtitle={copy.delete.body}
          leading={<RowIcon name="trash-outline" tone="danger" />}
          onPress={() => router.push(SETTINGS_HREFS.deleteAccount)}
          testID="account-delete"
        />
      </Section>

      <Button
        label={signingOut ? copy.signingOut : copy.signOut}
        icon="log-out-outline"
        variant="secondary"
        loading={signingOut}
        onPress={() => void signOut()}
        testID="account-sign-out"
      />
    </Screen>
  );
}
