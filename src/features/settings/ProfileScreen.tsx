import { useRouter } from 'expo-router';
import { useState } from 'react';
import { TextInput, useWindowDimensions, View } from 'react-native';

import { useSession } from '@/data/supabase/session';
import { NAME_MAX_CHARS } from '@/features/auth/prefillName';
import { useRewards } from '@/features/rewards/useRewards';
import { classView } from '@/features/rewards/viewModel';
import { TripTopBar } from '@/features/trips/TopBar';
import { Banner, Button, Card, Screen, Skeleton, Text, useTheme } from '@/ui';

import { settingsCopy } from './copy';
import { FieldLabel } from './parts';
import { saveDisplayName, type SaveNameDeps } from './profile';
import { Portrait } from './SettingsScreen';

const copy = settingsCopy.profile;

/**
 * H1 · Profile, lean: the first name, editable, and the class the rewards have given (read only,
 * from the server's settled progress). Save is the one primary action, bottom-anchored, and only
 * live when the name has changed.
 */
export function ProfileScreen({ deps = {} }: { deps?: { update?: SaveNameDeps['update'] } }) {
  const th = useTheme();
  const router = useRouter();
  const { session, profile, refreshProfile } = useSession();
  const rewards = useRewards();
  const { fontScale } = useWindowDimensions();
  const scale = Math.min(fontScale, 2);
  const saved = profile?.display_name ?? '';
  const [name, setName] = useState(saved);
  const [focused, setFocused] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saved' | 'empty' | 'failed'>('idle');
  const back = router.canGoBack() ? () => router.back() : null;
  const userId = session?.user.id ?? null;
  const changed = name.trim() !== saved.trim();

  const onSave = async () => {
    if (userId === null || busy) return;
    setBusy(true);
    const r = await saveDisplayName(userId, name, { update: deps.update, refresh: refreshProfile });
    setBusy(false);
    if (r.ok) {
      setName(r.name);
      setStatus('saved');
    } else {
      setStatus(r.reason);
    }
  };

  let klass;
  if (rewards.data) {
    const k = classView(rewards.data.snapshot.progress);
    klass = (
      <Text variant="title3" testID="profile-class">
        {copy.className(k.name)}
      </Text>
    );
  } else if (rewards.isError) {
    klass = (
      <Text variant="subhead" tone="muted" testID="profile-class-unread">
        {copy.classUnread}
      </Text>
    );
  } else {
    klass = (
      <View accessible accessibilityLabel={copy.classLoading}>
        <Skeleton width="45%" height={22} />
      </View>
    );
  }

  return (
    <Screen testID="profile-screen">
      <TripTopBar title={copy.title} onBack={back} />
      <View style={{ flex: 1, gap: th.space.xl }}>
        <View style={{ alignItems: 'center' }}>
          <Portrait name={name || saved} size={72} />
        </View>
        <View style={{ gap: th.space.xs }}>
          <FieldLabel>{copy.nameLabel}</FieldLabel>
          <TextInput
            testID="profile-name-input"
            accessibilityLabel={copy.nameLabel}
            accessibilityHint={copy.nameHint}
            value={name}
            onChangeText={(v) => {
              setName(v);
              if (status !== 'idle') setStatus('idle');
            }}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onSubmitEditing={() => void onSave()}
            maxLength={NAME_MAX_CHARS}
            autoCapitalize="words"
            autoComplete="given-name"
            textContentType="givenName"
            returnKeyType="done"
            selectionColor={th.colors.accent}
            cursorColor={th.colors.accent}
            allowFontScaling={false}
            style={{
              minHeight: 48 * scale,
              borderWidth: 1.5,
              borderColor: status === 'empty' ? th.colors.danger : focused ? th.colors.accent : th.colors.borderStrong,
              borderRadius: th.radius.md,
              paddingHorizontal: th.space.md,
              backgroundColor: th.colors.surface,
              color: th.colors.text,
              fontSize: 17 * scale,
            }}
          />
          <Text variant="footnote" tone={status === 'empty' ? 'danger' : 'muted'} accessibilityLiveRegion="polite" testID="profile-name-note">
            {status === 'empty' ? copy.nameEmpty : status === 'saved' ? copy.saved : copy.nameHint}
          </Text>
        </View>
        {status === 'failed' ? <Banner testID="profile-save-error" tone="warning" message={copy.saveError} /> : null}
        <Card testID="profile-class-card">
          <FieldLabel>{copy.classLabel}</FieldLabel>
          {klass}
          <Text variant="footnote" tone="muted">
            {copy.classHow}
          </Text>
        </Card>
      </View>
      <Button
        testID="profile-save"
        label={copy.save}
        onPress={() => void onSave()}
        loading={busy}
        disabled={!changed || userId === null}
      />
    </Screen>
  );
}
