/**
 * The old name of Home's notice store (`./homeNotice.ts`), kept only so the session's sign-out
 * (`src/data/supabase/session.tsx`) still clears it until it imports `clearHomeNotice` itself.
 * New code imports `./homeNotice`.
 */
export {
  clearHomeNotice as clearStartNotice,
  readHomeNotice as readStartNotice,
  showHomeNotice as showStartNotice,
} from './homeNotice';
export type { HomeNotice as StartNotice } from './homeNotice';
