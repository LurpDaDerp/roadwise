import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { Button, Sheet, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../copy';

const copy = dashpalCopy.screen.addPhoneSheet;

/** COMMAND 3 opens the dashcam's pairing window for 120 s, for one phone. */
export const ADD_PHONE_WINDOW_MS = 120_000;

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Add another phone: the dashcam's pairing window is open for 2 minutes, for one phone. The sheet
 * says where to set it up on the other phone and how long pairing stays open, then that it closed.
 * There is no code: the other phone sets the DashPal up with one tap while the window is open.
 */
export function AddPhoneSheet({ openedAt, onClose, now = Date.now }: { openedAt: number | null; onClose(): void; now?: () => number }) {
  const th = useTheme();
  return (
    <Sheet visible={openedAt !== null} onClose={onClose} title={copy.title} testID="dashcam-add-phone-sheet">
      {openedAt !== null ? <AddPhoneBody key={openedAt} openedAt={openedAt} now={now} /> : null}
      <Button label={copy.done} variant="ghost" onPress={onClose} testID="add-phone-done" style={{ marginTop: th.space.sm }} />
    </Sheet>
  );
}

function AddPhoneBody({ openedAt, now }: { openedAt: number; now: () => number }) {
  const th = useTheme();
  const [left, setLeft] = useState(() => ADD_PHONE_WINDOW_MS - (now() - openedAt));

  useEffect(() => {
    const timer = setInterval(() => setLeft(ADD_PHONE_WINDOW_MS - (now() - openedAt)), 1000);
    return () => clearInterval(timer);
    // `now` and `openedAt` are fixed for this body (it is keyed by `openedAt`).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (left <= 0) {
    return (
      <Text variant="body" testID="add-phone-ended">
        {copy.ended}
      </Text>
    );
  }
  return (
    <View style={{ gap: th.space.md, alignItems: 'center' }}>
      <Text variant="headline" testID="add-phone-left">
        {copy.left(mmss(left))}
      </Text>
      <Text variant="subhead" tone="muted" style={{ textAlign: 'center' }} testID="add-phone-body">
        {copy.body}
      </Text>
    </View>
  );
}
