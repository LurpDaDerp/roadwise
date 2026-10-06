import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import { useEffect, useState } from 'react';
import { Share, TextInput, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { useMySummary } from '@/data/server/summary';
import { Section, TopBar } from '@/features/settings/parts';
import { searchQuery, useSearchUsers } from '@/features/social/api';
import { addLink, profileHref } from '@/features/social/links';
import { Avatar, Button, Card, ListRow, Screen, Skeleton, Text, useFontScale, useTheme } from '@/ui';

import { friendsCopy as copy } from './copy';

export const SCAN_HREF = '/friends/scan' as Href;
export const SEARCH_DEBOUNCE_MS = 350;

/** `text`, settled for `ms`. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * `/friends/add`: search by username (3+ letters, debounced), your own QR code (the
 * `roadwise://add/<username>` link, also shareable), and the way to scan a friend's.
 */
export function AddFriendsScreen({ debounceMs = SEARCH_DEBOUNCE_MS }: { debounceMs?: number }) {
  const th = useTheme();
  const scale = useFontScale();
  const router = useRouter();
  const me = useMySummary().data?.profile.username ?? null;
  const [text, setText] = useState('');
  const query = searchQuery(useDebounced(text, debounceMs));
  const results = useSearchUsers(query);
  const typed = text.trim().length;

  const link = me ? addLink(me) : null;

  return (
    <Screen scroll testID="add-friends-screen">
      <TopBar title={copy.addTitle} />

      <View style={{ gap: th.space.sm }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: th.space.sm,
            minHeight: 48 * scale,
            paddingHorizontal: th.space.md,
            borderRadius: th.radius.pill,
            backgroundColor: th.colors.surface,
            borderWidth: 1.5,
            borderColor: th.colors.border,
          }}
        >
          <Ionicons name="search" size={th.size.icon} color={th.colors.textMuted} />
          <TextInput
            testID="friends-search"
            accessibilityLabel={copy.searchLabel}
            accessibilityHint={copy.searchHint}
            value={text}
            onChangeText={setText}
            placeholder={copy.searchPlaceholder}
            placeholderTextColor={th.colors.textSubtle}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            spellCheck={false}
            maxLength={20}
            allowFontScaling={false}
            returnKeyType="search"
            style={{ flex: 1, color: th.colors.text, fontSize: 17 * scale, paddingVertical: th.space.sm }}
          />
        </View>
        {typed > 0 && typed < 3 ? (
          <Text variant="footnote" tone="muted">
            {copy.searchHint}
          </Text>
        ) : null}
      </View>

      {query !== null ? (
        results.data ? (
          results.data.length === 0 ? (
            <Text variant="subhead" tone="muted" testID="search-empty">
              {copy.noResults(query)}
            </Text>
          ) : (
            <Section testID="search-results">
              {results.data.map((r) => (
                <ListRow
                  key={r.user_id}
                  title={r.username}
                  subtitle={`${copy.level(r.level)} · ${copy.rating(r.safety_rating)}`}
                  leading={<Avatar username={r.username} size="md" />}
                  onPress={() => router.push(profileHref(r.username))}
                  testID={`result-${r.username}`}
                />
              ))}
            </Section>
          )
        ) : results.isError ? (
          <Text variant="subhead" tone="danger" testID="search-error">
            {copy.searchError}
          </Text>
        ) : (
          <Skeleton width="100%" height={56} />
        )
      ) : null}

      <Card testID="my-code" style={{ alignItems: 'center', gap: th.space.md }}>
        <Text variant="title3">{copy.myCode}</Text>
        {link && me ? (
          <>
            <View
              accessible
              accessibilityRole="image"
              accessibilityLabel={`${copy.myCode}: ${me}`}
              style={{ padding: th.space.md, backgroundColor: '#FFFFFF', borderRadius: th.radius.lg }}
            >
              <QRCode value={link} size={200} color="#001D3D" backgroundColor="#FFFFFF" ecl="M" />
            </View>
            <Text variant="headline">{`@${me}`}</Text>
            <Text variant="subhead" tone="muted" style={{ textAlign: 'center' }}>
              {copy.myCodeBody}
            </Text>
            <Button
              label={copy.share}
              icon="share-outline"
              variant="ghost"
              size="md"
              onPress={() => void Share.share({ message: copy.shareMessage(link) }).catch(() => {})}
              testID="share-link"
            />
          </>
        ) : (
          <Text variant="subhead" tone="muted">
            {copy.noUsername}
          </Text>
        )}
      </Card>

      <Button label={copy.scan} icon="scan" onPress={() => router.push(SCAN_HREF)} testID="scan-code" />
    </Screen>
  );
}
