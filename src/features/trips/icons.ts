import type { Ionicons } from '@expo/vector-icons';

import type { TipCategory } from '@/content/tips';

/**
 * One drawn mark per scoring category, at one stroke weight, used everywhere a category has to be
 * recognised without reading: the coaching card's mark, and the pins on the D2 map (§7.D D2,
 * "event pins with category icons").
 *
 * `general` is the tip catalogue's own category for advice that belongs to no detector; no event
 * ever carries it.
 */
export const CATEGORY_ICON: Record<TipCategory, keyof typeof Ionicons.glyphMap> = {
  phone: 'phone-portrait-outline',
  speeding: 'speedometer-outline',
  braking: 'hand-left-outline',
  accel: 'trending-up-outline',
  cornering: 'return-down-forward-outline',
  focus: 'eye-outline',
  general: 'compass-outline',
};

/** An event whose category this build does not know still gets a pin, just not a claim. */
export const UNKNOWN_CATEGORY_ICON: keyof typeof Ionicons.glyphMap = 'ellipse-outline';
