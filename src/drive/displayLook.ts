// The sky the background driving display wears (the iOS Live Activity, the Android notification):
// the root layout sets it whenever the theme's mood changes, and the display adapter stamps it on
// every state it sends. Null until the first mood: the native surfaces keep their plain look.

/** "#RRGGBB" each: the driving screen's deepened sky top to bottom, and the sky accent. */
export type DisplayLook = { skyTop: string; skyMid: string; skyLow: string; accent: string };

let current: DisplayLook | null = null;

export function setDisplayLook(look: DisplayLook | null): void {
  current = look;
}

export function displayLook(): DisplayLook | null {
  return current;
}
