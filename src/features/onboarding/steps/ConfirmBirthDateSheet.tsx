import { Modal, View } from 'react-native';

import { useLockout } from '@/features/drive/useLockout';
import { Button, Text, useTheme } from '@/ui';

import { formatBirthDate, onboardingCopy } from '../copy';

const copy = onboardingCopy.confirmBirthDate;

/**
 * The one look before a write that cannot be taken back: the birth date the driver typed, spelled
 * out ("March 4, 2008") so a swapped month and day is obvious, and that it can't be changed later.
 * The date and nothing else — no age, no hint of what the answer leads to.
 *
 * "Yes, that's right" is the only way to the write (the caller's `onConfirm`); "Edit" and the
 * system back gesture close the sheet and send nothing. A failed write is reported here, and the
 * same button tries again.
 *
 * A native `Modal` renders above the driving lockout, so it closes itself while that is on
 * (rev1: I12), as the dispute sheet does; the typed date stays in the step behind it.
 */
export function ConfirmBirthDateSheet({
  visible,
  iso,
  busy,
  failed,
  onConfirm,
  onEdit,
}: {
  visible: boolean;
  /** `YYYY-MM-DD`, already validated. */
  iso: string | null;
  busy: boolean;
  failed: boolean;
  onConfirm: () => void;
  onEdit: () => void;
}) {
  const th = useTheme();
  const lockedOut = useLockout();
  const open = visible && iso !== null && !lockedOut;

  return (
    <Modal
      visible={open}
      transparent
      animationType={th.reduceMotion ? 'none' : 'slide'}
      // Back while a write is out would leave its answer nowhere to land; it waits for the reply.
      onRequestClose={busy ? () => {} : onEdit}
      testID="confirm-birth-date"
    >
      {open && iso !== null ? (
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: th.colors.scrim }}>
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: th.colors.bgElevated,
              borderTopLeftRadius: th.radius.xl,
              borderTopRightRadius: th.radius.xl,
              borderTopWidth: 1,
              borderColor: th.colors.border,
              paddingHorizontal: th.space.lg,
              paddingTop: th.space.xl,
              paddingBottom: th.space.xxl,
              gap: th.space.lg,
            }}
          >
            <View style={{ gap: th.space.sm }}>
              <Text variant="title3" accessibilityRole="header">
                {copy.title}
              </Text>
              <Text variant="title1" testID="confirm-birth-date-value">
                {formatBirthDate(iso)}
              </Text>
              <Text variant="callout" tone="muted">
                {copy.fixed}
              </Text>
            </View>

            {failed ? (
              <Text
                variant="callout"
                tone="danger"
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
              >
                {copy.saveFailed}
              </Text>
            ) : null}

            <View style={{ gap: th.space.sm }}>
              <Button label={copy.confirm} onPress={onConfirm} loading={busy} />
              <Button label={copy.edit} onPress={onEdit} variant="ghost" disabled={busy} />
            </View>
          </View>
        </View>
      ) : null}
    </Modal>
  );
}
