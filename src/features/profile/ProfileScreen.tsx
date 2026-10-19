import { useRouter, type Href } from 'expo-router';
import { RefreshControl, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useMySummary } from '@/data/server/summary';
import { useFriends } from '@/features/social/api';
import { LinkRow, Section } from '@/features/settings/parts';
import { SETTINGS_HREFS } from '@/features/settings/routes';
import { Banner, Card, Pill, ScreenTitle, SectionHeader, Skeleton, useSkyScrollHandler, useTheme } from '@/ui';

import { AchievementBadges } from './AchievementBadges';
import { profileCopy as copy } from './copy';
import { ProfileHeader } from './ProfileHeader';

export const PROFILE_HREFS = {
  achievements: '/achievements' as Href,
  friends: '/friends' as Href,
  heatmap: '/heatmap' as Href,
} as const;

/**
 * The Profile tab: the public card (what others see, plus your points and freezes), the five
 * achievements, then everything about you and your account: friends, who can see your heat map, how
 * points work, settings, account and blocked users. It sits on the page sky, so the title uses the
 * white sky ink and the pull-to-refresh spinner does too. Like every tab, it scrolls below the
 * status bar (clipped at the safe area), never under it.
 */
export function ProfileScreen() {
  const th = useTheme();
  const router = useRouter();
  const summary = useMySummary();
  const friends = useFriends();
  const data = summary.data;
  const requests = friends.data?.incoming.length ?? 0;
  // the sky behind the tabs scrolls with Profile
  const onScroll = useSkyScrollHandler();

  return (
    <SafeAreaView style={{ flex: 1 }} edges={['top', 'left', 'right']} testID="profile-safe-area">
      <Animated.ScrollView
        testID="profile-screen"
        style={{ flex: 1 }}
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentContainerStyle={{ padding: th.space.lg, gap: th.space.xl }}
        refreshControl={
          <RefreshControl
            refreshing={summary.isRefetching}
            onRefresh={() => void Promise.all([summary.refetch(), friends.refetch()])}
            tintColor={th.onSky.text}
          />
        }
      >
        <ScreenTitle onSky testID="profile-title">
          {copy.tab}
        </ScreenTitle>

        {data && data.profile.username ? (
          <ProfileHeader
            testID="profile-card"
            username={data.profile.username}
            level={data.progress.level}
            safetyRating={data.progress.safety_rating}
            ranked={data.progress.ranked}
            streak={data.progress.streak}
            own={{
              points: data.progress.points,
              lifetime: data.progress.lifetime,
              levelFloor: data.progress.level_floor,
              levelNext: data.progress.level_next,
              miles30d: data.progress.miles_30d,
              nextMult: data.progress.next_mult,
              atRisk: data.progress.at_risk,
              freezes: data.progress.freezes,
            }}
          />
        ) : summary.isError ? (
          <Banner
            tone="danger"
            message={copy.loadError}
            action={{ label: copy.retry, onPress: () => void summary.refetch() }}
            testID="profile-load-error"
          />
        ) : (
          <Skeleton width="100%" height={240} radius={th.radius.card} />
        )}

        <View style={{ gap: th.space.md }}>
          <SectionHeader
            title={copy.achievements.title}
            action={{ label: copy.achievements.seeAll, onPress: () => router.push(PROFILE_HREFS.achievements) }}
          />
          <Card onPress={() => router.push(PROFILE_HREFS.achievements)} accessibilityLabel={copy.achievements.title} testID="profile-achievements">
            <AchievementBadges unlocked={data?.achievements ?? []} />
          </Card>
        </View>

        <Section>
          <LinkRow
            icon="people-outline"
            title={copy.rows.friends.title}
            subtitle={copy.rows.friends.subtitle}
            trailing={requests > 0 ? <Pill label={copy.rows.requests(requests)} tone="gold" icon="person-add" emphasis="solid" /> : undefined}
            onPress={() => router.push(PROFILE_HREFS.friends)}
            testID="profile-friends"
          />
          <LinkRow icon="map-outline" title={copy.rows.heatmap.title} subtitle={copy.rows.heatmap.subtitle} onPress={() => router.push(PROFILE_HREFS.heatmap)} testID="profile-heatmap" />
          <LinkRow icon="help-circle-outline" title={copy.rows.how.title} subtitle={copy.rows.how.subtitle} onPress={() => router.push(SETTINGS_HREFS.howPointsWork)} testID="profile-how" />
        </Section>

        <Section>
          <LinkRow icon="settings-outline" title={copy.rows.settings.title} subtitle={copy.rows.settings.subtitle} onPress={() => router.push(SETTINGS_HREFS.root)} testID="profile-settings" />
          <LinkRow icon="person-circle-outline" title={copy.rows.account.title} subtitle={copy.rows.account.subtitle} onPress={() => router.push(SETTINGS_HREFS.account)} testID="profile-account" />
          <LinkRow icon="ban-outline" title={copy.rows.blocked.title} subtitle={copy.rows.blocked.subtitle} onPress={() => router.push(SETTINGS_HREFS.blocked)} testID="profile-blocked" />
        </Section>
      </Animated.ScrollView>
    </SafeAreaView>
  );
}
