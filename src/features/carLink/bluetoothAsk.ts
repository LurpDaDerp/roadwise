// Pairing a car asks for Bluetooth once (`src/core/permissions/carBluetooth.ts`): on iPhone after the
// car is paired ("Are you driving?" then knows when Bluetooth is on; a car paired before this ask
// existed is asked for when Settings shows Your car, `useCarLink({ askIfPaired })`); on Android 12+
// Nearby devices before it (ruling 14: the car is then paired by its full Bluetooth address, its
// connecting can wake detection, and the radio can be read). Once the phone has answered, nothing is
// shown again. A denial changes nothing about the pairing. Never throws.
import { Platform } from 'react-native';

import { androidApiLevel, androidPermissions, lazyBluetooth } from '@/core/permissions/adapters';
import { askBluetoothForCar, askNearbyForCar } from '@/core/permissions/carBluetooth';
import type { Db } from '@/data/db';
import { createSettingsRepo } from '@/data/db/settings';

/** One ask at a time (the Settings row and the Your car screen may both ask as they show). */
let asking: Promise<void> | null = null;

/** Android 12+, as the driver taps "Use this car" (before the pairing): Nearby devices, once. Nothing on iPhone. */
export async function askBluetoothBeforePair(db: Db): Promise<void> {
  if (Platform.OS !== 'android') return;
  asking ??= askNearbyForCar({ settings: createSettingsRepo(db), android: { permissions: androidPermissions, apiLevel: androidApiLevel() } })
    .catch(() => false)
    .then(() => {
      asking = null;
    });
  await asking;
}

/** iPhone, once a car is paired: Bluetooth, once. Nothing on Android (asked before the pairing). */
export async function askBluetoothOnPair(db: Db): Promise<void> {
  if (Platform.OS !== 'ios') return;
  asking ??= askBluetoothForCar({ platform: 'ios', settings: createSettingsRepo(db), radio: lazyBluetooth })
    .catch(() => null)
    .then(() => {
      asking = null;
    });
  await asking;
}
