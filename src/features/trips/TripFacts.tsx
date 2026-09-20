import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import type { TripSummary } from '@/data/queries';
import { Text, useTheme } from '@/ui';

import { tripCopy as copy } from './copy';
import { Field, FieldText } from './Field';
import { ICON, TIGHT } from './layout';
import { QualityStamp } from './QualityStamp';

/** One fact and its value, printed the way a licence prints a field within a field. */
function Fact({
  label,
  value,
  icon,
  testID,
}: {
  label: string;
  value: string;
  icon?: keyof typeof Ionicons.glyphMap;
  testID?: string;
}) {
  const th = useTheme();
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="text"
      accessibilityLabel={`${label}: ${value}`}
      style={{ gap: TIGHT, flexGrow: 1, flexBasis: 128 }}
    >
      <Text variant="caption" tone="subtle" style={{ textTransform: 'uppercase' }}>
        {label}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: th.space.xs }}>
        {icon ? <Ionicons name={icon} size={ICON.sm} color={th.colors.textMuted} /> : null}
        <FieldText variant="subhead" style={{ flexShrink: 1 }}>
          {value}
        </FieldText>
      </View>
    </View>
  );
}

/**
 * The CONDITIONS panel (§7.D D2): what the road and the phone were like, as words with a glyph —
 * never a row of icons a driver has to decode.
 *
 * Road types are not here: M2 stores no road classification, and a field that always reads
 * "Not recorded" is noise. Speed-limit coverage is, because it is the one condition that changes
 * whether speeding could be scored at all (§9.3).
 */
export function TripConditionsField({ trip, testID }: { trip: TripSummary; testID?: string }) {
  const th = useTheme();
  const { night, precipitation } = trip.conditions;
  const pct = trip.limitCoveragePct;
  return (
    <Field label={copy.detail.conditionsLabel} testID={testID}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: th.space.lg }}>
        <Fact
          label={copy.conditionsPanel.light}
          value={night ? copy.conditionsPanel.night : copy.conditionsPanel.day}
          icon={night ? 'moon-outline' : 'sunny-outline'}
        />
        <Fact
          label={copy.conditionsPanel.weather}
          value={precipitation ? copy.conditionsPanel.rain : copy.conditionsPanel.dry}
          icon={precipitation ? 'rainy-outline' : 'partly-sunny-outline'}
        />
        <Fact
          label={copy.conditionsPanel.limits}
          value={
            pct === null
              ? copy.conditionsPanel.limitsUnknown
              : copy.conditionsPanel.limitsPct(Math.round(pct))
          }
          icon="speedometer-outline"
        />
        <Fact
          label={copy.conditionsPanel.camera}
          value={
            trip.cameraSession ? copy.conditionsPanel.cameraOn : copy.conditionsPanel.cameraOff
          }
          icon="eye-outline"
        />
      </View>
    </Field>
  );
}

/**
 * The DATA QUALITY panel (§7.D D2): the grade, what it means in words, how the phone was carried,
 * and — when crash recovery finished the drive — the warning that its tail is missing (§19.1).
 *
 * The grade is the tappable stamp, which is where "A / B / C, tap for meaning" is satisfied for
 * the whole app: it opens E4. The raw GPS percentage behind the grade is not stored on device, so
 * it is not printed; claiming a number the row does not hold would be the opposite of the point
 * of this panel.
 */
export function TripQualityField({ trip, testID }: { trip: TripSummary; testID?: string }) {
  const th = useTheme();
  return (
    <Field label={copy.detail.qualityLabel} testID={testID}>
      <View style={{ gap: th.space.md }}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: th.space.lg }}>
          {trip.dataQuality ? (
            <QualityStamp grade={trip.dataQuality} size="md" testID="quality-stamp" />
          ) : (
            <Text variant="subhead" tone="muted">
              {copy.qualityPanel.gpsUnknown}
            </Text>
          )}
          {trip.mode !== null ? (
            <Fact label={copy.qualityPanel.sensors} value={trip.mode} icon="phone-portrait-outline" />
          ) : null}
        </View>

        {trip.incomplete ? (
          <View
            testID="quality-recovered"
            style={{
              gap: TIGHT,
              padding: th.space.md,
              borderRadius: th.radius.sm,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: th.colors.border,
              backgroundColor: th.colors.surfaceRaised,
            }}
          >
            <Text variant="subhead">{copy.qualityPanel.recovered}</Text>
            <Text variant="footnote" tone="muted">
              {copy.qualityPanel.recoveredBody}
            </Text>
          </View>
        ) : null}
      </View>
    </Field>
  );
}
