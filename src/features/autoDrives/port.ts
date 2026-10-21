/**
 * The one door from the screens to the native auto-detect status (the boot package owns the read).
 * Kept apart so a screen test can stand in for it without loading the drive machinery.
 */
export { readAutoDetectStatus } from '@/boot/autoDetect';
