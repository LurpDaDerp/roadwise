import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, View } from 'react-native';

import type { HealthRow as HealthRowModel, HealthStatus, PermissionSnapshot } from '@/core/permissions';
import type { BatteryGuide } from '@/data/config/appConfig';
import { Button, Text, useTheme } from '@/ui';

import { permissionsCopy as copy } from './copy';

/** What a row's Fix does. B2 turns each into one adapter call or one navigation. */
export type FixTarget =
  | 'requestLocation'
  | 'requestMotion'
  | 'requestNotifications'
  /** Background location: always through the prominent disclosure first (design §5.3). */
  | 'disclosure'
  /** Always is allowed, but this account never affirmed the disclosure (Task 19 r1): the same screen. */
  | 'reviewDisclosure'
  | 'openSettings'
  | 'openBatterySettings';

/**
 * The Fix a row offers, or null. `info` rows have none — they explain a choice, a withdrawn
 * feature or something that cannot be checked — with one exception the brief names: Android's
 * battery row that cannot be read still offers its settings page (next to the maker's guide),
 * because the driver can check there what the app cannot. It is never offered for a choice.
 */
export function fixFor(row: HealthRowModel, snapshot: PermissionSnapshot): FixTarget | null {
  if (row.fix === 'none') {
    return row.id === 'battery' && row.reason === 'cantCheck' ? 'openBatterySettings' : null;
  }
  if (row.fix === 'openBatterySettings') return 'openBatterySettings';
  switch (row.id) {
    case 'locationAlways':
      return 'disclosure';
    case 'autoRecord':
      // This account's affirmation (Task 19 r1): the disclosure, though the phone allows Always.
      if (row.reason === 'notAffirmed') return 'reviewDisclosure';
      // Whatever blocks it: Always first (through the disclosure), then motion.
      if (snapshot.location !== 'always') return 'disclosure';
      return row.fix === 'request' ? 'requestMotion' : 'openSettings';
    case 'location':
      return row.fix === 'request' ? 'requestLocation' : 'openSettings';
    case 'motion':
      return row.fix === 'request' ? 'requestMotion' : 'openSettings';
    case 'notifications':
      return row.fix === 'request' ? 'requestNotifications' : 'openSettings';
    default:
      return 'openSettings';
  }
}

export const FIX_LABEL: Record<FixTarget, string> = {
  requestLocation: copy.fix.location,
  requestMotion: copy.fix.motion,
  requestNotifications: copy.fix.notifications,
  disclosure: copy.fix.background,
  reviewDisclosure: copy.fix.review,
  openSettings: copy.fix.openSettings,
  openBatterySettings: copy.fix.openBatterySettings,
};

const FIX_HINT: Partial<Record<FixTarget, string>> = {
  disclosure: copy.fixHint.background,
  reviewDisclosure: copy.fixHint.review,
  openSettings: copy.fixHint.openSettings,
};

type Glyph = keyof typeof Ionicons.glyphMap;

/** A drawn glyph per status as well as its ink, so the meaning never rides on colour alone. */
const GLYPH: Record<HealthStatus, Glyph> = {
  ok: 'checkmark-circle',
  attention: 'alert-circle',
  off: 'close-circle',
  info: 'information-circle',
};

/**
 * One B2 checklist row, ruled like a field on the licence record: the status glyph, the name,
 * the status word, one consequence line and, when there is something to do, its Fix. Screen
 * readers hear the status first ("Location: needs attention", product B2 A11y).
 */
export function HealthRow({
  title,
  statusLabel,
  status,
  consequence,
  fix,
  onFix,
  busy,
  guide,
  testID,
}: {
  title: string;
  statusLabel: string;
  status: HealthStatus;
  consequence: string;
  fix: FixTarget | null;
  onFix: (fix: FixTarget) => void;
  busy?: boolean;
  /** Android battery: the maker's steps, printed under the consequence. */
  guide?: BatteryGuide | null;
  testID?: string;
}) {
  const th = useTheme();
  const ink = {
    ok: th.colors.success,
    attention: th.colors.warning,
    off: th.colors.danger,
    info: th.colors.textMuted,
  }[status];

  return (
    <View
      testID={testID}
      style={{
        gap: th.space.sm,
        paddingVertical: th.space.md,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: th.colors.border,
      }}
    >
      <View
        accessible
        accessibilityLabel={`${title}: ${statusLabel.toLowerCase()}. ${consequence}`}
        style={{ flexDirection: 'row', gap: th.space.md, alignItems: 'flex-start' }}
      >
        <Ionicons name={GLYPH[status]} size={22} color={ink} style={{ marginTop: 1 }} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: th.space.sm, alignItems: 'baseline' }}>
            <Text variant="headline">{title}</Text>
            <Text variant="footnote" style={{ color: ink, fontWeight: '600' }}>
              {statusLabel}
            </Text>
          </View>
          <Text variant="subhead" tone="muted">
            {consequence}
          </Text>
        </View>
      </View>
      {guide ? (
        <View style={{ gap: th.space.xs, paddingLeft: 22 + th.space.md }} testID={testID ? `${testID}-guide` : undefined}>
          <Text variant="footnote" tone="subtle" accessibilityRole="header">
            {guide.title}
          </Text>
          {guide.steps.map((step, i) => (
            <Text key={i} variant="footnote" tone="muted">
              {`${i + 1}. ${step}`}
            </Text>
          ))}
        </View>
      ) : null}
      {fix ? (
        <View style={{ paddingLeft: 22 + th.space.md, alignItems: 'flex-start' }}>
          <Button
            label={FIX_LABEL[fix]}
            variant="secondary"
            size="md"
            loading={busy}
            onPress={() => onFix(fix)}
            accessibilityHint={FIX_HINT[fix]}
            testID={testID ? `${testID}-fix` : undefined}
          />
        </View>
      ) : null}
    </View>
  );
}
