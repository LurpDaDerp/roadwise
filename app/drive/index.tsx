import { HudScreen } from '@/features/drive/HudScreen';

/**
 * `/drive` — the full-screen driving screen. The root stack presents it as a full-screen modal with
 * no swipe-back; `LockoutGate` keeps the screen awake and swallows Android back while recording.
 */
export default function DrivingRoute() {
  return <HudScreen />;
}
