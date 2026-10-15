import 'expo-router/entry';

import { ensureRuntime } from '@/boot/controller';
import { registerDriveHeadlessTask } from '@/boot/headless';
import { startDashpalEarly } from '@/dashcam/early';

// Android: N3's CaptureService starts `DriveSenseTask` when it restarts (START_STICKY) a capture the
// driver started, with no app in front. Registered at module load, before any React tree, as
// headless JS requires.
registerDriveHeadlessTask();

// DashPal (only for a driver who opted in): the BLE manager starts at module load, so an iOS
// Bluetooth relaunch is restored and a paired dashcam reconnects before the runtime is up; frames
// wait for the link bootstrap attaches.
void startDashpalEarly();

// Boot eagerly: a background launch (a mid-drive relaunch or restart) must pick up the open drive
// without waiting for a screen to mount. The root layout joins this same launch; a
// failure is shown there, with its retry.
void ensureRuntime().catch(() => {});
