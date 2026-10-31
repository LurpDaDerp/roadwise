/**
 * The one door from the screens to the car link (the boot package owns the native calls). Kept
 * apart so a screen test can stand in for it without loading the drive machinery.
 */
export { forgetCar, notMyCar, onCarLink, pairCar, readCarLink } from '@/boot/autoDetect';
