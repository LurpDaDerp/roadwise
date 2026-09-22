import { useRouter, type Href } from 'expo-router';
import { View } from 'react-native';

import { AutoRecordPanel, useAutoRecord, type AutoRecordDeps } from '@/features/onboarding/AutoRecordPanel';
import { onboardingCopy } from '@/features/onboarding/copy';
import { PERMISSIONS_HREF } from '@/features/permissions/PermissionHealthBanner';
import { REPAIR_HREF } from '@/features/permissions/PermissionHealthScreen';
import { TripTopBar } from '@/features/trips/TopBar';
import { Button, Screen, Text, useTheme } from '@/ui';

const HOME = '/(tabs)/home' as Href;
const panelCopy = onboardingCopy.autoRecord;

/** The route's own words; the panel's are A9's (one copy for the control). */
export const autoRecordRouteCopy = {
  title: 'Auto-record',
  fixAlways: { ios: 'Set location to Always', android: 'Allow all the time' },
  fixAlwaysHint: 'Explains how RoadWise uses your location in the background, then asks',
  fixOther: 'Fix in Permissions',
  fixOtherHint: 'Opens permission health',
} as const;

/**
 * `/permissions/auto-record` — the post-onboarding place to turn auto-record on or off (Task 19;
 * it replaced M3's interim detection screen). A9's `AutoRecordPanel` — whose model opens the
 * disclosure in place when this account has not affirmed it (Task 19 r1) — plus a Fix for what
 * blocks it: a missing Always opens the prominent disclosure first, never an OS prompt; anything
 * else opens B2. Home's status line leads here.
 */
export function AutoRecordScreen({ deps }: { deps?: AutoRecordDeps }) {
  const th = useTheme();
  const router = useRouter();
  const openDisclosure = () => router.push(REPAIR_HREF);
  // The shared model gates turning on behind this account's disclosure (Task 19 r1).
  const model = useAutoRecord({ disclosureReason: 'repair', ...deps });
  const back = router.canGoBack() ? () => router.back() : () => router.replace(HOME);

  let fix = null;
  if (model.status === 'ready' && model.mode === 'blocked') {
    fix =
      model.blocker === 'always' ? (
        <Button
          label={autoRecordRouteCopy.fixAlways[model.platform]}
          variant="secondary"
          onPress={openDisclosure}
          accessibilityHint={autoRecordRouteCopy.fixAlwaysHint}
          testID="auto-record-fix-always"
        />
      ) : (
        <Button
          label={autoRecordRouteCopy.fixOther}
          variant="secondary"
          onPress={() => router.push(PERMISSIONS_HREF)}
          accessibilityHint={autoRecordRouteCopy.fixOtherHint}
          testID="auto-record-fix-permissions"
        />
      );
  }

  return (
    <Screen scroll testID="auto-record-screen">
      <TripTopBar title={autoRecordRouteCopy.title} onBack={back} />
      <Text variant="body" tone="muted">
        {panelCopy.body}
      </Text>
      <View style={{ gap: th.space.lg }}>
        <AutoRecordPanel model={model} />
        {fix}
      </View>
    </Screen>
  );
}

export default function AutoRecordRoute() {
  return <AutoRecordScreen />;
}
