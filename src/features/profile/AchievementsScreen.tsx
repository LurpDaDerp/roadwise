import { View } from 'react-native';

import { useMySummary } from '@/data/server/summary';
import { TopBar } from '@/features/settings/parts';
import { Banner, Card, Pill, Screen, Skeleton, Text, useTheme } from '@/ui';

import { AchievementMedal } from './AchievementBadges';
import { achievementViews } from './achievements';
import { profileCopy } from './copy';

const copy = profileCopy.achievements;

/**
 * `/achievements`: the three in the spec’s order, unlocked ones in gold, each with how to get it.
 * Until the summary has loaded nothing is shown as locked: placeholders, or the error with Try again.
 */
export function AchievementsScreen() {
  const th = useTheme();
  const query = useMySummary();
  const summary = query.data;
  const views = achievementViews(summary?.achievements ?? []);
  const got = views.filter((v) => v.unlocked).length;

  if (!summary) {
    return (
      <Screen scroll testID="achievements-screen">
        <TopBar title={copy.title} />
        {query.isError ? (
          <Banner
            tone="danger"
            message={profileCopy.loadError}
            action={{ label: profileCopy.retry, onPress: () => void query.refetch() }}
            testID="achievements-load-error"
          />
        ) : (
          views.map((a) => <Skeleton key={a.id} width="100%" height={92} radius={th.radius.card} testID={`achievement-loading-${a.id}`} />)
        )}
      </Screen>
    );
  }

  return (
    <Screen scroll testID="achievements-screen">
      <TopBar title={copy.title} trailing={<Pill label={copy.count(got, views.length)} tone="gold" icon="trophy" />} />
      {views.map((a) => (
        <Card key={a.id} testID={`achievement-row-${a.id}`} style={{ flexDirection: 'row', gap: th.space.lg, alignItems: 'center' }}>
          <AchievementMedal id={a.id} unlocked={a.unlocked} size={60} />
          <View style={{ flex: 1, gap: th.space.xs }} accessible accessibilityLabel={`${a.title}, ${a.unlocked ? copy.unlocked : copy.locked}. ${a.hint}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.sm, flexWrap: 'wrap' }}>
              <Text variant="title3">{a.title}</Text>
              {a.unlocked ? <Pill label={copy.unlocked} tone="clean" icon="checkmark" /> : null}
            </View>
            <Text variant="subhead" tone="muted" testID={`achievement-hint-${a.id}`}>
              {a.hint}
            </Text>
          </View>
        </Card>
      ))}
    </Screen>
  );
}
