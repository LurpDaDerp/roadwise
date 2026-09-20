import { View } from 'react-native';

import type { TripSummary, UnscoredReason } from '@/data/queries';
import { Text, useTheme } from '@/ui';
import { ScoreRing, Stamp } from '@/ui/charts';

import { tripCopy as copy } from './copy';
import { Field, FieldText } from './Field';
import { unscoredCopy } from './format';
import { QualityStamp } from './QualityStamp';

/**
 * The SCORE field (§7.D D1): the ring with its band, the data-quality grade stamped beside it
 * with its words, and PROVISIONAL across the ring until the server confirms the score. A clean
 * drive is stamped CLEAN DRIVE — the one moment on the screen that moves, and it holds still
 * under reduce motion. Without a score the field says why, and a passenger trip is stamped.
 */
export function TripScoreField({
  trip,
  unscoredReason,
  perfect,
}: {
  trip: TripSummary;
  unscoredReason: UnscoredReason | null;
  perfect: boolean;
}) {
  const th = useTheme();
  const grade = trip.dataQuality;
  const gradeStamp = grade ? <QualityStamp grade={grade} testID="stamp-quality" /> : null;

  if (trip.scored && trip.score !== null && trip.band !== null) {
    return (
      <Field label={copy.score.label}>
        <View
          style={{
            flexDirection: 'row',
            flexWrap: 'wrap',
            alignItems: 'center',
            justifyContent: 'center',
            gap: th.space.xl,
            paddingVertical: th.space.sm,
          }}
        >
          <ScoreRing
            score={trip.score}
            band={trip.band}
            provisional={trip.status === 'provisional'}
            testID="score-ring"
          />
          <View style={{ gap: th.space.lg, alignItems: 'flex-start' }}>
            {perfect ? (
              <Stamp kind="safeDay" label={copy.perfect.stamp} testID="stamp-clean-drive" />
            ) : null}
            {gradeStamp}
          </View>
        </View>
      </Field>
    );
  }

  const words = unscoredCopy(trip, unscoredReason);
  return (
    <Field label={copy.score.label}>
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: th.space.lg,
          paddingVertical: th.space.sm,
        }}
      >
        <View style={{ flexGrow: 1, flexShrink: 1, minWidth: '55%', gap: th.space.xs }}>
          <FieldText variant="title2">{words.title}</FieldText>
          <Text variant="subhead" tone="muted">
            {words.body}
          </Text>
        </View>
        <View style={{ gap: th.space.lg, alignItems: 'flex-start' }}>
          {words.stamp === 'passenger' ? <Stamp kind="passenger" testID="stamp-passenger" /> : null}
          {grade === 'C' ? gradeStamp : null}
        </View>
      </View>
    </Field>
  );
}
