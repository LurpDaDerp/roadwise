import * as Haptics from 'expo-haptics';
import { useEffect } from 'react';
import { View } from 'react-native';

import { Banner, Button, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../../copy';
import type { PairedDashcam } from '../../keys';
import { Checkmark } from './Checkmark';
import { announce, StepTitle } from './StepTitle';

const copy = dashpalCopy.wizard.done;

/** Setup finished: "DashPal is ready", how many phones from 2, and Done (no Cancel). */
export function StepDone({
  paired,
  phones,
  notAllYours,
  aimedElsewhere,
  onDone,
}: {
  paired: PairedDashcam;
  phones: number | null;
  notAllYours: boolean;
  aimedElsewhere: boolean;
  onDone(): void;
}) {
  const th = useTheme();
  useEffect(() => {
    announce(copy.title);
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, []);
  return (
    <View style={{ gap: th.space.md }}>
      <View style={{ alignItems: 'center', paddingVertical: th.space.sm }}>
        <Checkmark still testID="wizard-done-check" />
      </View>
      <StepTitle testID="wizard-done-title">{copy.title}</StepTitle>
      <Text variant="body" testID="wizard-done-body">
        {copy.body(paired.name)}
      </Text>
      {phones !== null && phones >= 2 ? (
        <Text variant="callout" tone="muted" testID="wizard-done-phones">
          {copy.phones(phones)}
        </Text>
      ) : null}
      {aimedElsewhere ? (
        <Text variant="callout" tone="muted" testID="wizard-done-aimed-elsewhere">
          {copy.aimedElsewhere}
        </Text>
      ) : null}
      {notAllYours ? <Banner tone="warning" message={copy.notAllYours} testID="wizard-done-not-all-yours" /> : null}
      <Button label={copy.button} onPress={onDone} style={{ marginTop: th.space.sm }} testID="wizard-done" />
    </View>
  );
}
