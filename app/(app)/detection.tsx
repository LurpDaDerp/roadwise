import { DetectionScreen } from '@/features/drive/DetectionScreen';

/**
 * `/(app)/detection` — turning auto-record on or off (R16), pushed from Home's detection status
 * line. M4 replaces the screen behind it with A9 and the full disclosure flow.
 */
export default function DetectionRoute() {
  return <DetectionScreen />;
}
