/** The shapes a Wrapped's month and share id take (pure: no server client). */

/** `YYYY-MM` with a real month. */
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
/** A share id: 12 letters and digits (`create_wrapped_share`). */
export const SHARE_ID_RE = /^[A-Za-z0-9]{12}$/;
