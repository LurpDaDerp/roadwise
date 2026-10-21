// The sky the background driving display wears (the iOS Live Activity, the Android notification):
// the root layout sets it whenever the theme's mood changes, and the display adapter stamps it on
// every state it sends. Null until the first mood: the native surfaces keep their plain look.

/**
 * "#RRGGBB" each: the driving screen's deepened sky top to bottom, and the sky accent. `night`
 * (optional): the driving screen's night look as the theme decides it (a static theme's own choice);
 * absent, the drive host reads the sun at the car, as the driving screen does on Adaptive.
 */
export type DisplayLook = { skyTop: string; skyMid: string; skyLow: string; accent: string; night?: boolean };

let current: DisplayLook | null = null;

export function setDisplayLook(look: DisplayLook | null): void {
  current = look;
}

export function displayLook(): DisplayLook | null {
  return current;
}
