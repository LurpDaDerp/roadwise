import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { Button, Text, useTheme } from '@/ui';

import { permissionsCopy as copy, type StatusWord } from './copy';

const GLYPH: Record<StatusWord, keyof typeof Ionicons.glyphMap> = {
  on: 'checkmark-circle',
  notYet: 'alert-circle',
  off: 'close-circle',
  idle: 'remove-circle-outline',
  unknown: 'help-circle-outline',
};

/**
 * One permission: a drawn glyph and a status word (never colour alone), what it means, its fix when
 * there is one, and "Hidden from Home" with Show on Home for a row hidden from Home. Screen readers
 * hear the status first.
 */
export function HealthRow({
  title,
  word,
  required,
  detail,
  fixLabel,
  onFix,
  busy,
  hiddenFromHome,
  onShowOnHome,
  testID,
}: {
  title: string;
  word: StatusWord;
  /** Off is shown in the danger colour (a drive cannot record), not the warning one. */
  required: boolean;
  detail: string;
  fixLabel: string | null;
  onFix: () => void;
  busy?: boolean;
  hiddenFromHome?: boolean;
  onShowOnHome?: () => void;
  testID?: string;
}) {
  const th = useTheme();
  const ink = {
    on: th.colors.success,
    notYet: th.colors.warning,
    off: required ? th.colors.danger : th.colors.warning,
    idle: th.colors.textMuted,
    unknown: th.colors.textMuted,
  }[word];
  const status = copy.status[word];
  return (
    <View testID={testID} style={{ gap: th.space.sm, paddingVertical: th.space.md, paddingHorizontal: th.space.lg }}>
      <View
        accessible
        accessibilityLabel={`${title}: ${status.toLowerCase()}. ${detail}${hiddenFromHome ? ` ${copy.hiddenFromHome}.` : ''}`}
        style={{ flexDirection: 'row', gap: th.space.md, alignItems: 'flex-start' }}
      >
        <Ionicons name={GLYPH[word]} size={22} color={ink} style={{ marginTop: 1 }} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: th.space.sm, alignItems: 'baseline' }}>
            <Text variant="headline">{title}</Text>
            <Text variant="footnote" style={{ color: ink, fontWeight: '600' }} testID={testID ? `${testID}-status` : undefined}>
              {status}
            </Text>
          </View>
          <Text variant="subhead" tone="muted" testID={testID ? `${testID}-detail` : undefined}>
            {detail}
          </Text>
          {hiddenFromHome ? (
            <Text variant="footnote" tone="muted" testID={testID ? `${testID}-hidden` : undefined}>
              {copy.hiddenFromHome}
            </Text>
          ) : null}
        </View>
      </View>
      {fixLabel || hiddenFromHome ? (
        <View style={{ paddingLeft: 22 + th.space.md, flexDirection: 'row', flexWrap: 'wrap', gap: th.space.sm, alignItems: 'flex-start' }}>
          {fixLabel ? (
            <Button label={fixLabel} variant="secondary" size="sm" loading={busy} onPress={onFix} testID={testID ? `${testID}-fix` : undefined} />
          ) : null}
          {hiddenFromHome && onShowOnHome ? (
            <Button label={copy.showOnHome} variant="ghost" size="sm" onPress={onShowOnHome} testID={testID ? `${testID}-show` : undefined} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
