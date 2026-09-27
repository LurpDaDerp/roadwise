// The alert style control's words (Alerts and sounds). Kept apart from `settings/copy.ts`.
import type { AlertStyle } from '@/core/alerts/types';

export const alertStyleCopy = {
  title: 'How alerts reach you',
  hint: 'Vibration works with the phone in a pocket or on the seat.',
  options: {
    both: 'Sound and vibration',
    vibration: 'Vibration only',
    sound: 'Sound only',
  } satisfies Record<AlertStyle, string>,
} as const;
