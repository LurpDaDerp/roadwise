// Pairing a car asks for Bluetooth once (iPhone): "Are you driving?" then knows when Bluetooth is on
// (`src/core/permissions/carBluetooth.ts`). A car paired before this ask existed is asked for when
// Settings shows Your car (`useCarLink({ askIfPaired })`); once the phone has answered, nothing is
// shown again. A denial changes nothing about the pairing. Never throws.
import { Platform } from 'react-native';

import { lazyBluetooth } from '@/core/permissions/adapters';
import { askBluetoothForCar } from '@/core/permissions/carBluetooth';
import type { Db } from '@/data/db';
import { createSettingsRepo } from '@/data/db/settings';

/** One ask at a time (the Settings row and the Your car screen may both ask as they show). */
let asking: Promise<void> | null = null;

export async function askBluetoothOnPair(db: Db): Promise<void> {
  if (Platform.OS !== 'ios') return;
  asking ??= askBluetoothForCar({ platform: 'ios', settings: createSettingsRepo(db), radio: lazyBluetooth })
    .catch(() => null)
    .then(() => {
      asking = null;
    });
  await asking;
}
