/**
 * The one door from the screens to the native auto-detect status (the boot package owns the read)
 * and to the Automatic drives switch. Kept apart so a screen test can stand in for it without
 * loading the drive machinery.
 */
export { readAutoDetectStatus, setAutoDetectEnabled } from '@/boot/autoDetect';
