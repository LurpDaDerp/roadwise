import { View } from 'react-native';

import { Card, IconButton, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../copy';
import type { DashcamState } from '../runtime';
import { useDashcamRuntime, useDashcamSelector } from './useDashcam';

const copy = dashpalCopy.screen;

const selectNotice = (s: DashcamState | null): boolean => s?.newPhone === true && s.link.paired !== null;

/**
 * Home's one-time card (pairing v2 §9.8): the paired DashPal reported a phone this phone did not add.
 * Shown under the permission card until its ✕ (top right); never while a drive is open (Home shows
 * the drive strip instead, `hidden`).
 */
export function NewPhoneCard({ hidden = false }: { hidden?: boolean }) {
  const th = useTheme();
  const runtime = useDashcamRuntime();
  const show = useDashcamSelector(selectNotice);
  if (!show || hidden || !runtime) return null;
  return (
    <Card testID="home-dashpal-new-phone">
      <View style={{ flexDirection: 'row', gap: th.space.sm }}>
        <Text variant="callout" style={{ flex: 1 }}>
          {copy.newPhone}
        </Text>
        <IconButton
          icon="close"
          accessibilityLabel={copy.newPhoneDismiss}
          onPress={() => void runtime.dismissNewPhone()}
          style={{ alignSelf: 'flex-start' }}
          testID="home-dashpal-new-phone-dismiss"
        />
      </View>
    </Card>
  );
}
