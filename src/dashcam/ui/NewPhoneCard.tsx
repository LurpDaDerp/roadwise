import { View } from 'react-native';

import { Button, Card, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../copy';
import type { DashcamState } from '../runtime';
import { useDashcamRuntime, useDashcamSelector } from './useDashcam';

const copy = dashpalCopy.screen;

const selectNotice = (s: DashcamState | null): boolean => s?.newPhone === true && s.link.paired !== null;

/**
 * Home's one-time card (pairing v2 §9.8): the paired DashPal reported a phone this phone did not add.
 * Shown under the permission card until OK; never while a drive is open (Home shows the drive strip
 * instead, `hidden`).
 */
export function NewPhoneCard({ hidden = false }: { hidden?: boolean }) {
  const th = useTheme();
  const runtime = useDashcamRuntime();
  const show = useDashcamSelector(selectNotice);
  if (!show || hidden || !runtime) return null;
  return (
    <Card testID="home-dashpal-new-phone">
      <Text variant="callout">{copy.newPhone}</Text>
      <View style={{ flexDirection: 'row', marginTop: th.space.sm }}>
        <Button label={copy.newPhoneOk} size="sm" variant="secondary" onPress={() => void runtime.dismissNewPhone()} testID="home-dashpal-new-phone-ok" />
      </View>
    </Card>
  );
}
