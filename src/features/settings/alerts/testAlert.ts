/**
 * H4's *Test alert*: one L2 warning through the real alert ports and player, so the driver hears
 * exactly what a drive plays — the L2 tone, then "Slow down" if voice is on, then the double pulse.
 * Only on a tap and only while no drive is recording (the screen checks): the ports are loaded then,
 * and each tone player is released when its tone ends, so nothing is left running (design §3.5).
 */
import { createExpoAlertPorts } from '@/core/alerts/adapters';
import { createAlertPlayer, type AlertPlayerDeps } from '@/core/alerts/player';
import type { AlertDecision } from '@/core/alerts/types';

import { voicePrefEnabled } from './voicePref';

export type TestAlertOutcome = 'played' | 'failed';

export interface TestAlertDeps {
  loadPorts?: () => Promise<Pick<AlertPlayerDeps, 'audio' | 'voice' | 'haptics'>>;
  voiceEnabled?: () => boolean;
  now?: () => number;
}

export async function playTestAlert(deps: TestAlertDeps = {}): Promise<TestAlertOutcome> {
  let ports: Pick<AlertPlayerDeps, 'audio' | 'voice' | 'haptics'>;
  try {
    ports = await (deps.loadPorts ?? createExpoAlertPorts)();
  } catch {
    return 'failed';
  }
  let failed = false;
  const player = createAlertPlayer({
    ...ports,
    voiceEnabled: deps.voiceEnabled ?? voicePrefEnabled,
    callActive: () => false,
    // Parked, in the app: the audible playback session, whatever the ringer switch says.
    l1RespectsSilentSwitch: () => false,
    onUnavailable: () => {
      failed = true;
    },
  });
  const decision: AlertDecision = {
    id: 'settings-test-alert',
    level: 2,
    kind: 'speeding',
    ts: (deps.now ?? Date.now)(),
    voice: 'alert.slowDown',
  };
  await player.deliver(decision);
  return failed ? 'failed' : 'played';
}
