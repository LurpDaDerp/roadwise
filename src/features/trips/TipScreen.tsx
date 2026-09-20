import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { TipCategory } from '@/content/tips';
import { createSettingsRepo } from '@/data/db';
import { useDb, useTrip, useTripEvents } from '@/data/queries';
import { Banner, Button, EmptyState, Screen, Skeleton, Text, useTheme } from '@/ui';

import { tripCopy as copy } from './copy';
import { Field, FieldText } from './Field';
import { describeEvent, formatClock } from './format';
import { tipForTrip } from './tip';

/** Where "Practice this week" is kept until the weekly focus (§10.4, M5) has a home of its own. */
export const WEEKLY_FOCUS_KEY = 'focus.weekly';

export interface WeeklyFocus {
  tipId: string;
  setAt: number;
}

const MARK: Record<TipCategory, keyof typeof Ionicons.glyphMap> = {
  phone: 'phone-portrait-outline',
  speeding: 'speedometer-outline',
  braking: 'hand-left-outline',
  accel: 'trending-up-outline',
  cornering: 'return-down-forward-outline',
  focus: 'eye-outline',
  general: 'compass-outline',
};

/** How many of the drive's own events the tip shows as examples (§7.D D6: one or two). */
const MAX_EXAMPLES = 2;

function BackButton({ onPress }: { onPress: () => void }) {
  const th = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copy.back}
      onPress={onPress}
      hitSlop={th.space.sm}
      style={({ pressed }) => ({
        alignSelf: 'flex-start',
        minWidth: 44,
        minHeight: 44,
        alignItems: 'center',
        justifyContent: 'center',
        marginLeft: -th.space.sm,
        borderRadius: th.radius.pill,
        backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
      })}
    >
      <Ionicons name="chevron-back" size={26} color={th.colors.accent} />
    </Pressable>
  );
}

/**
 * D6 — one tip, read in full (§7.D D6): title, the two or three sentences, why it matters, one
 * or two moments from this drive it is about, and "Practice this week". The clean-drive card has
 * nothing to practise, so it carries Done instead.
 */
export function TipScreen({ clientTripId }: { clientTripId: string }) {
  const router = useRouter();
  const th = useTheme();
  const db = useDb();
  const detailQuery = useTrip(clientTripId);
  const eventsQuery = useTripEvents(clientTripId);
  const [focus, setFocus] = useState<'idle' | 'saving' | 'set' | 'error'>('idle');

  const back = () => (router.canGoBack() ? router.back() : router.dismissTo('/(tabs)/home'));

  if (detailQuery.isPending || eventsQuery.isPending) {
    return (
      <Screen scroll>
        <BackButton onPress={back} />
        <Skeleton width="80%" height={34} />
        <Skeleton width="100%" height={66} />
        <Skeleton width="60%" height={22} />
      </Screen>
    );
  }

  if (detailQuery.error || eventsQuery.error) {
    return (
      <Screen>
        <BackButton onPress={back} />
        <Banner
          tone="danger"
          message={copy.error.message}
          action={{
            label: copy.error.retry,
            onPress: () => {
              void detailQuery.refetch();
              void eventsQuery.refetch();
            },
          }}
        />
      </Screen>
    );
  }

  const detail = detailQuery.data;
  if (!detail) {
    return (
      <Screen>
        <BackButton onPress={back} />
        <EmptyState title={copy.notFound.title} body={copy.notFound.body} />
      </Screen>
    );
  }

  const tipped = tipForTrip(detail, eventsQuery.data ?? []);
  if (!tipped.tip) {
    // The drive is on the record; there is simply nothing to coach — an unscored drive, or one
    // whose costliest category has no tip in the catalogue. Saying "this drive isn't on your
    // record" here would be untrue (Task 6 review, M-1).
    return (
      <Screen>
        <BackButton onPress={back} />
        <EmptyState title={copy.noTip.title} body={copy.noTip.body} testID="no-tip" />
      </Screen>
    );
  }

  const { tip, outcome } = tipped;
  const examples =
    tip.category === 'general'
      ? []
      : (eventsQuery.data ?? [])
          .filter((event) => event.category === tip.category && event.affectsScore)
          .slice(0, MAX_EXAMPLES);

  const practice = async () => {
    setFocus('saving');
    try {
      const value: WeeklyFocus = { tipId: tip.id, setAt: Date.now() };
      await createSettingsRepo(db).set(WEEKLY_FOCUS_KEY, value);
      setFocus('set');
    } catch {
      setFocus('error');
    }
  };

  return (
    <Screen scroll testID="tip-screen">
      <BackButton onPress={back} />

      <View style={{ gap: th.space.lg }}>
        <View
          accessible={false}
          style={{
            width: 64,
            height: 64,
            borderRadius: 32,
            backgroundColor: th.colors.accentFaint,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name={MARK[tip.category]} size={32} color={th.colors.accent} />
        </View>
        <Text variant="title1" accessibilityRole="header">
          {tip.title}
        </Text>
        <Text variant="body">{tip.body}</Text>
      </View>

      <Field label={copy.tipScreen.why}>
        <Text variant="body">{tip.why}</Text>
      </Field>

      {examples.length > 0 ? (
        <Field label={copy.tipScreen.fromThisDrive} testID="examples">
          <View accessibilityRole="list">
            {examples.map((event, index) => (
              <View
                key={event.id}
                accessible
                accessibilityRole="text"
                accessibilityLabel={`${formatClock(event.startedAt, detail.trip.tz)}, ${describeEvent(event)}`}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: th.space.md,
                  minHeight: 44,
                  paddingVertical: th.space.sm,
                  borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                  borderTopColor: th.colors.divider,
                }}
              >
                <FieldText face="numeral" tone="muted">
                  {formatClock(event.startedAt, detail.trip.tz)}
                </FieldText>
                <Text variant="body" style={{ flex: 1 }}>
                  {describeEvent(event)}
                </Text>
              </View>
            ))}
          </View>
        </Field>
      ) : null}

      <View style={{ flexGrow: 1, minHeight: th.space.lg }} />

      {outcome === 'keep_it_up' ? (
        <Button label={copy.done} onPress={back} testID="done" />
      ) : (
        <View style={{ gap: th.space.sm }}>
          {focus === 'set' ? (
            <Text variant="callout" tone="accent" accessibilityLiveRegion="polite">
              {copy.tipScreen.focusConfirm}
            </Text>
          ) : null}
          {focus === 'error' ? (
            <Text
              variant="callout"
              tone="danger"
              accessibilityRole="alert"
              accessibilityLiveRegion="polite"
            >
              {copy.tipScreen.error}
            </Text>
          ) : null}
          <Button
            label={focus === 'set' ? copy.tipScreen.focusSet : copy.tipScreen.practice}
            onPress={() => void practice()}
            loading={focus === 'saving'}
            disabled={focus === 'set'}
            testID="practice"
          />
        </View>
      )}
    </Screen>
  );
}
