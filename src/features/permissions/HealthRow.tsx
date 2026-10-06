import { Ionicons } from '@expo/vector-icons';
import { View } from 'react-native';

import { Button, Text, useTheme } from '@/ui';

import { permissionsCopy as copy } from './copy';
import type { Fix, RowStatus } from './health';

const GLYPH: Record<RowStatus, keyof typeof Ionicons.glyphMap> = {
  ok: 'checkmark-circle',
  attention: 'alert-circle',
  off: 'close-circle',
};

/**
 * One permission: a drawn glyph and a status word (never colour alone), what it means for a drive,
 * and its Fix when there is one. Screen readers hear the status first.
 */
export function HealthRow({
  title,
  status,
  detail,
  fix,
  onFix,
  busy,
  testID,
}: {
  title: string;
  status: RowStatus;
  detail: string;
  fix: Fix | null;
  onFix: (fix: Fix) => void;
  busy?: boolean;
  testID?: string;
}) {
  const th = useTheme();
  const ink = { ok: th.colors.success, attention: th.colors.warning, off: th.colors.danger }[status];
  const word = copy.status[status];
  return (
    <View testID={testID} style={{ gap: th.space.sm, paddingVertical: th.space.md, paddingHorizontal: th.space.lg }}>
      <View
        accessible
        accessibilityLabel={`${title}: ${word.toLowerCase()}. ${detail}`}
        style={{ flexDirection: 'row', gap: th.space.md, alignItems: 'flex-start' }}
      >
        <Ionicons name={GLYPH[status]} size={22} color={ink} style={{ marginTop: 1 }} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: th.space.sm, alignItems: 'baseline' }}>
            <Text variant="headline">{title}</Text>
            <Text variant="footnote" style={{ color: ink, fontWeight: '600' }} testID={testID ? `${testID}-status` : undefined}>
              {word}
            </Text>
          </View>
          <Text variant="subhead" tone="muted">
            {detail}
          </Text>
        </View>
      </View>
      {fix ? (
        <View style={{ paddingLeft: 22 + th.space.md, alignItems: 'flex-start' }}>
          <Button
            label={copy.fix[fix]}
            variant="secondary"
            size="sm"
            loading={busy}
            onPress={() => onFix(fix)}
            testID={testID ? `${testID}-fix` : undefined}
          />
        </View>
      ) : null}
    </View>
  );
}
