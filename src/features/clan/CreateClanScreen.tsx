import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { Button, Screen, Text, useTheme } from '@/ui';

import { CLAN_BANNERS, useServerAction, type ClanBanner } from './api';
import { BANNER_ART } from './banners';
import { ClanBannerArt, TextField, TopBar } from './components';
import { clanCopy } from './copy';
import { CLAN_NAME_MAX, friendlyError, NAME_PROBLEM_COPY, validateClanName } from './model';
import { CLAN_TAB_HREF } from './routes';

const copy = clanCopy.create;

function BannerPicker({ value, onChange }: { value: ClanBanner; onChange: (b: ClanBanner) => void }) {
  const t = useTheme();
  return (
    <View style={{ gap: t.space.xs }}>
      <Text variant="label" tone="muted">
        {copy.bannerLabel}
      </Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={copy.bannerLabel} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
        {CLAN_BANNERS.map((b) => {
          const art = BANNER_ART[b];
          const selected = b === value;
          return (
            <Pressable
              key={b}
              accessibilityRole="radio"
              accessibilityLabel={art.label}
              accessibilityState={{ selected, checked: selected }}
              onPress={() => onChange(b)}
              testID={`banner-${b}`}
              style={({ pressed }) => ({
                width: 72,
                alignItems: 'center',
                gap: t.space.xs,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              <View
                style={{
                  width: 64,
                  height: 48,
                  borderRadius: t.radius.md,
                  borderCurve: 'continuous',
                  backgroundColor: art.face[0],
                  borderWidth: selected ? 3 : 0,
                  borderColor: t.colors.accent,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {selected ? <Ionicons name="checkmark-circle" size={24} color={art.ink} /> : null}
              </View>
              <Text variant="caption" tone={selected ? 'default' : 'muted'}>
                {art.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/** Name (3–24, checked as you type) and one of eight banners; you become the leader. */
export function CreateClanScreen() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [banner, setBanner] = useState<ClanBanner>('navy');
  const [touched, setTouched] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const create = useServerAction<{ p_name: string; p_banner: ClanBanner }>('create_clan');

  const problem = validateClanName(name);
  const shown = serverError ?? (touched && problem ? NAME_PROBLEM_COPY[problem] : null);

  const submit = async () => {
    setTouched(true);
    if (problem || create.isPending) return;
    try {
      await create.mutateAsync({ p_name: name.trim(), p_banner: banner });
      router.replace(CLAN_TAB_HREF);
    } catch (err) {
      setServerError(friendlyError(err));
    }
  };

  return (
    <Screen scroll testID="clan-create">
      <TopBar title={copy.title} />
      <ClanBannerArt banner={banner} name={name.trim() || copy.namePlaceholder} subtitle={copy.preview} compact testID="create-preview" />
      <TextField
        label={copy.nameLabel}
        placeholder={copy.namePlaceholder}
        value={name}
        onChangeText={(v) => {
          setName(v);
          setServerError(null);
          if (v.trim().length >= 3) setTouched(true);
        }}
        onBlur={() => setTouched(name.length > 0)}
        maxLength={CLAN_NAME_MAX + 4}
        autoCapitalize="words"
        autoCorrect={false}
        returnKeyType="done"
        hint={copy.nameHint}
        error={shown}
        testID="clan-name"
      />
      <BannerPicker value={banner} onChange={setBanner} />
      <View style={{ flex: 1 }} />
      <Button
        label={copy.submit}
        size="lg"
        loading={create.isPending}
        disabled={problem !== null}
        onPress={() => void submit()}
        testID="clan-create-submit"
      />
    </Screen>
  );
}
