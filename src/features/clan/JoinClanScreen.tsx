import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { ReportSheet } from '@/features/social/ReportSheet';
import { Banner, Button, Screen, Skeleton, useTheme } from '@/ui';

import { useClanPreview, useServerAction } from './api';
import { ClanBannerArt, TextField, TopBar } from './components';
import { clanCopy } from './copy';
import { friendlyError, isValidCode, normalizeCode } from './model';
import { CLAN_TAB_HREF } from './routes';

const copy = clanCopy.join;

/** Join by code: type or paste it (or arrive from `roadwise://clan/<code>`), check the preview, join. */
export function JoinClanScreen() {
  const t = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ code?: string }>();
  const initial = normalizeCode(typeof params.code === 'string' ? params.code : '');
  const [input, setInput] = useState(initial);
  const [lookup, setLookup] = useState<string | null>(isValidCode(initial) ? initial : null);
  const [tried, setTried] = useState(false);
  const [reporting, setReporting] = useState(false);
  const preview = useClanPreview(lookup);
  const join = useServerAction<{ p_code: string }>('join_clan');

  const code = normalizeCode(input);
  const codeError = tried && !isValidCode(code) ? copy.badCode : null;

  const find = () => {
    setTried(true);
    join.reset();
    if (!isValidCode(code)) return;
    if (code === lookup) void preview.refetch();
    else setLookup(code);
  };

  const submit = async () => {
    if (!lookup || join.isPending) return;
    try {
      await join.mutateAsync({ p_code: lookup });
      router.replace(CLAN_TAB_HREF);
    } catch {
      // shown from join.error below
    }
  };

  const clan = preview.data;
  const showForm = lookup === null || preview.isError;

  return (
    <Screen scroll testID="clan-join">
      <TopBar title={copy.title} />
      {showForm ? (
        <View style={{ gap: t.space.lg }}>
          <TextField
            label={copy.codeLabel}
            placeholder={copy.codePlaceholder}
            value={input}
            onChangeText={(v) => {
              setInput(v);
              setTried(false);
            }}
            onSubmitEditing={find}
            autoCapitalize="characters"
            autoCorrect={false}
            autoComplete="off"
            returnKeyType="search"
            hint={copy.codeHint}
            error={codeError ?? (preview.isError ? friendlyError(preview.error) : null)}
            testID="clan-code-input"
          />
          <Button
            label={copy.find}
            size="lg"
            variant="secondary"
            icon="search"
            loading={preview.isFetching}
            onPress={find}
            testID="clan-find"
          />
        </View>
      ) : clan ? (
        <View style={{ gap: t.space.lg }} testID="clan-preview">
          <ClanBannerArt banner={clan.banner} name={clan.name} subtitle={copy.members(clan.member_count)} />
          {clan.full ? <Banner tone="warning" message={copy.full} testID="clan-full" /> : null}
          {join.isError ? <Banner tone="danger" message={friendlyError(join.error)} testID="join-error" /> : null}
          <Button
            label={copy.submit}
            size="lg"
            icon="enter-outline"
            disabled={clan.full}
            loading={join.isPending}
            onPress={() => void submit()}
            testID="clan-join-submit"
          />
          <Button
            label={copy.differentCode}
            variant="ghost"
            onPress={() => {
              join.reset();
              setTried(false);
              setLookup(null);
            }}
          />
          {clan.id ? (
            <>
              <Button label={copy.report} variant="ghost" size="sm" icon="flag-outline" onPress={() => setReporting(true)} style={{ alignSelf: 'center' }} testID="clan-preview-report" />
              <ReportSheet visible={reporting} onClose={() => setReporting(false)} kind="clan" targetId={clan.id} name={clan.name} />
            </>
          ) : null}
        </View>
      ) : (
        <View style={{ gap: t.space.md }} accessible accessibilityLabel="Loading clan">
          <Skeleton width="100%" height={144} radius={t.radius.card} />
          <Skeleton width="100%" height={56} radius={t.radius.pill} />
        </View>
      )}
    </Screen>
  );
}
