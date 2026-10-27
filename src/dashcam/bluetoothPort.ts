// The DashPal radio for the permissions adapter (`BluetoothPort`): the BLE manager's state, read
// without creating the iOS manager (no prompt), or created on the driver's DashPal tap.
import type { BluetoothPort, RadioState } from '@/core/permissions/adapters';

import { getDashcamTransport, type DashcamTransport } from './transport';

/**
 * How long the start waits for Bluetooth's state to settle: on iOS that is the driver answering the
 * permission prompt, which waits on them (an answer later than this reads as undetermined).
 */
export const PROMPT_SETTLE_MS = 60_000;

export function createBluetoothPort(transport: () => DashcamTransport): BluetoothPort {
  return {
    async radio() {
      const t = transport();
      return t.started() ? (t.bluetoothState() as RadioState) : null;
    },
    async startRadio() {
      const t = transport();
      await t.start();
      return (await t.settledBluetoothState(PROMPT_SETTLE_MS)) as RadioState;
    },
  };
}

export const dashpalRadio: BluetoothPort = createBluetoothPort(getDashcamTransport);
