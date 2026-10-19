import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { profileCopy } from '@/features/profile/copy';
import { Banner, Card, Divider, Sheet, Text, useTheme } from '@/ui';

import { REPORT_REASONS, useServerAction, type ReportReason } from './api';

const copy = profileCopy.public;

/**
 * Report a driver: one tap on a reason sends it (`report_target` with kind `'user'`). Reports are
 * private; the sheet thanks the reporter and closes.
 */
export function ReportSheet({
  visible,
  onClose,
  targetId,
  name,
}: {
  visible: boolean;
  onClose: () => void;
  targetId: string;
  name: string;
}) {
  const th = useTheme();
  const action = useServerAction();
  const [sent, setSent] = useState(false);

  const send = async (reason: ReportReason) => {
    const ok = await action.run('report_target', { p_kind: 'user', p_target_id: targetId, p_reason: reason, p_note: '' });
    if (ok) setSent(true);
  };

  const close = () => {
    setSent(false);
    action.clearError();
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={close} title={copy.reportTitle(name)} testID="report-sheet">
      {sent ? (
        <Banner tone="success" message={copy.reported} testID="report-sent" />
      ) : (
        <>
          <Text variant="subhead" tone="muted">
            {copy.reportIntro}
          </Text>
          {action.error ? <Banner tone="danger" message={action.error} testID="report-error" /> : null}
          <Card padded={false}>
            {REPORT_REASONS.map((r, i) => (
              <View key={r}>
                {i > 0 ? <Divider inset={th.space.lg} /> : null}
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: action.pending !== null }}
                  disabled={action.pending !== null}
                  onPress={() => void send(r)}
                  testID={`report-${r}`}
                  style={({ pressed }) => ({
                    minHeight: th.size.touch + th.space.sm,
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: th.space.lg,
                    paddingVertical: th.space.sm,
                    backgroundColor: pressed ? th.colors.surfaceRaised : 'transparent',
                  })}
                >
                  <Text variant="body" style={{ flex: 1 }}>
                    {copy.reportReasons[r]}
                  </Text>
                  <Ionicons name="chevron-forward" size={18} color={th.colors.textSubtle} />
                </Pressable>
              </View>
            ))}
          </Card>
        </>
      )}
    </Sheet>
  );
}
