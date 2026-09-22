import 'expo-router/entry';

import { ensureRuntime } from '@/boot/controller';
import { registerDriveHeadlessTask } from '@/boot/headless';

// Android: N3's CaptureService starts `DriveSenseTask` when native begins a capture with no app in
// front. Registered at module load, before any React tree, as headless JS requires.
registerDriveHeadlessTask();

// Boot eagerly: a background launch (an iOS location wake or mid-drive relaunch) must start the
// drive engine without waiting for a screen to mount. The root layout joins this same launch; a
// failure is shown there, with its retry.
void ensureRuntime().catch(() => {});
