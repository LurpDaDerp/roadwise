import { useState } from 'react';
import { Linking, View } from 'react-native';

import { Banner, Button, Screen, Text, useTheme } from '@/ui';

export const updateRequiredCopy = {
  title: 'Update RoadWise to keep going',
  body: 'This version of RoadWise is out of date.',
  // Internal builds have no store listing (rev1: m): say where the update comes from, with no link.
  noStore: 'Update RoadWise from where you installed it',
  getUpdate: 'Get the update',
  opensStore: 'Opens the app store',
  openFailed: "Couldn't open the store. Update RoadWise from where you installed it.",
} as const;

/**
 * The forced-update gate's screen. It is shown only for a known, required update (never offline,
 * never on an unfetched minimum), and never over a drive (the gate holds while one is under way).
 * With a store link for this platform it offers exactly one action, the store; without one it
 * says where the update comes from and offers nothing it cannot do.
 */
export function UpdateRequiredScreen({
  storeUrl,
  open = (url: string) => Linking.openURL(url),
}: {
  storeUrl: string | null;
  open?: (url: string) => Promise<unknown>;
}) {
  const t = useTheme();
  const [failed, setFailed] = useState(false);

  const onGet = () => {
    if (!storeUrl) return;
    setFailed(false);
    open(storeUrl).catch(() => setFailed(true));
  };

  return (
    <Screen testID="update-required">
      <Text variant="title2" accessibilityRole="header">
        {updateRequiredCopy.title}
      </Text>
      <View style={{ height: t.space.sm }} />
      <Text variant="body" tone="muted">
        {updateRequiredCopy.body}
      </Text>
      {storeUrl ? null : (
        <>
          <View style={{ height: t.space.lg }} />
          <Text variant="body">{updateRequiredCopy.noStore}</Text>
        </>
      )}
      {failed ? (
        <View accessibilityLiveRegion="polite">
          <View style={{ height: t.space.lg }} />
          <Banner tone="danger" message={updateRequiredCopy.openFailed} />
        </View>
      ) : null}
      <View style={{ flexGrow: 1 }} />
      {storeUrl ? (
        <Button
          label={updateRequiredCopy.getUpdate}
          accessibilityHint={updateRequiredCopy.opensStore}
          onPress={onGet}
          testID="update-required-store"
        />
      ) : null}
    </Screen>
  );
}
