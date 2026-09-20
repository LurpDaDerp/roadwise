/**
 * The measurements the trip screens use that `src/ui/tokens.ts` does not (yet) name.
 *
 * Task 6's review (M-8) found touch-target and icon sizes typed as literals in eight files, and
 * asked for `tokens.size = { touch, icon }` in M0. That token set is not this task's to add
 * mid-milestone, so the values live here instead: one list, read by every trip screen, ready to
 * be deleted the day `tokens.size` lands. They are not arbitrary — `TOUCH` and `TOUCH_LG` are
 * §14's two floors, and the icon steps are the sizes `ListRow`, `Banner` and `Button` already use.
 */

/** §14: every control is at least this tall and wide. */
export const TOUCH = 44;

/** §14: in-drive and check-in surfaces, and a card-sized row that is itself the control. */
export const TOUCH_LG = 64;

/**
 * The sub-space step: a label and its value are one object, so they sit closer than `space.xs`.
 * `ListRow` and `Field` already draw this gap.
 */
export const TIGHT = 2;

/** Drawn-icon sizes, matched to the type they sit beside. */
export const ICON = {
  /** Inside a chip, beside `caption`. */
  xs: 14,
  /** Beside `footnote`. */
  sm: 16,
  /** A chevron beside `body` — `ListRow`'s own size. */
  md: 18,
  /** Beside `body` in a list row that carries meaning, not just direction. */
  lg: 22,
  /** A leading mark on a card. */
  xl: 26,
} as const;
