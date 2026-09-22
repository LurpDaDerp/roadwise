import { useFocusEffect, useRouter, type Href } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';

import { DISCLOSURE_AFFIRMED_KEY } from '@/core/permissions';
import { createSettingsRepo } from '@/data/db';
import { useDb } from '@/data/queries';
import { DISCLOSURE_VERSION } from '@/features/drive/detectionCopy';
import {
  AutoRecordPanel,
  useAutoRecord,
  type AutoRecordDeps,
  type AutoRecordModel,
} from '@/features/onboarding/AutoRecordPanel';
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
 * Whether the signed-in account has affirmed the current background-location disclosure on this
 * phone. The mark lives in settings, so a handover's wipe clears it: Always is device-level and
 * survives a new account, but the new account's consent does not exist until it sees the words.
 */
export function useDisclosureAffirmed(): boolean | null {
  const db = useDb();
  const settings = useMemo(() => createSettingsRepo(db), [db]);
  const [affirmed, setAffirmed] = useState<boolean | null>(null);
  // Re-read whenever the screen comes back into focus: the disclosure it opens may have been affirmed.
  useFocusEffect(
    useCallback(() => {
      let live = true;
      void settings
        .get<{ version?: unknown }>(DISCLOSURE_AFFIRMED_KEY)
        .then((v) => live && setAffirmed(v !== null && v.version === DISCLOSURE_VERSION))
        .catch(() => live && setAffirmed(false));
      return () => {
        live = false;
      };
    }, [settings])
  );
  return affirmed;
}

/**
 * Turning auto-record on here with Always already granted but no disclosure affirmed by this
 * account (an Always grant inherited from the phone's previous owner, or one made in Settings) goes
 * through the disclosure first (T9 security): Continue there records this account's consent and
 * turns auto-record on. Nothing else changes: off always goes straight to the host.
 */
export function withDisclosureGate(
  model: AutoRecordModel,
  affirmed: boolean | null,
  openDisclosure: () => void
): AutoRecordModel {
  if (model.status !== 'ready' || model.mode !== 'host') return model;
  return {
    ...model,
    setOn: async (enabled) => {
      if (enabled && affirmed !== true) {
        openDisclosure();
        return false;
      }
      return model.setOn(enabled);
    },
  };
}

/**
 * `/permissions/auto-record` — the post-onboarding place to turn auto-record on or off (Task 19;
 * it replaced M3's interim detection screen). A9's `AutoRecordPanel`, plus a Fix for what blocks
 * it: a missing Always opens the prominent disclosure first, never an OS prompt; anything else
 * opens B2. Home's status line leads here.
 */
export function AutoRecordScreen({ deps }: { deps?: AutoRecordDeps }) {
  const th = useTheme();
  const router = useRouter();
  const affirmed = useDisclosureAffirmed();
  const openDisclosure = () => router.push(REPAIR_HREF);
  const model = withDisclosureGate(useAutoRecord(deps), affirmed, openDisclosure);
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
