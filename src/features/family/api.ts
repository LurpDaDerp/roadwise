/**
 * The family calls (migration 0012). Every read and write is a definer RPC; the client never touches
 * a family table.
 *
 * - **One read.** `family_snapshot` answers the caller's family, members (each member's location
 *   only while that member shares and it is under a day old) and places, validated `.strict()`: an
 *   answer carrying anything else is refused whole (`unknown`), never shown.
 * - **Refusals.** 0012 raises most refusals with a fixed message; `join_family` returns them after
 *   its attempt is counted (the PostgREST error body with status 400/403), which supabase-js reports
 *   the same way. `FAMILY_ERROR_MESSAGES` maps each message to a code the screens word. A lock
 *   timeout (`55P03`) is `busy`; a request that never reached the server is `offline`.
 */
import { z } from 'zod';

import type { supabase as AppClient } from '@/data/supabase/client';

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

export const FAMILY_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

/** What a person typed or pasted, as the server reads it: letters and digits only, upper-cased. */
export function normaliseFamilyCode(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

const LocationSchema = z
  .object({
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    accuracyM: z.number().min(0),
    driving: z.boolean(),
    updatedAt: z.string(),
  })
  .strict();
export type MemberLocation = z.infer<typeof LocationSchema>;

const MemberSchema = z
  .object({
    userId: z.string().uuid(),
    name: z.string().max(40),
    role: z.enum(['admin', 'member']),
    isMe: z.boolean(),
    sharing: z.boolean(),
    location: LocationSchema.nullable(),
  })
  .strict();
export type FamilyMember = z.infer<typeof MemberSchema>;

const PlaceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(40),
    address: z.string().max(200),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    radiusM: z.number().int().min(50).max(2000),
  })
  .strict();
export type FamilyPlace = z.infer<typeof PlaceSchema>;

const FamilySchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1).max(40),
    myRole: z.enum(['admin', 'member']),
    mySharing: z.boolean(),
    /** The join code and its expiry: the admin's snapshot only. */
    code: z.string().regex(FAMILY_CODE_PATTERN).nullable(),
    codeExpiresAt: z.string().nullable(),
    members: z.array(MemberSchema).min(1).max(8),
    places: z.array(PlaceSchema).max(20),
  })
  .strict();
export type Family = z.infer<typeof FamilySchema>;

export const FamilySnapshotSchema = z.object({ family: FamilySchema.nullable() }).strict();
export type FamilySnapshot = z.infer<typeof FamilySnapshotSchema>;

const FamilyIdSchema = z.object({ familyId: z.string().uuid() }).strict();
const CodeAnswerSchema = z.object({ code: z.string().regex(FAMILY_CODE_PATTERN), codeExpiresAt: z.string() }).strict();
const PostAnswerSchema = z.object({ accepted: z.boolean() }).strict();
const PlaceIdSchema = z.object({ id: z.string().uuid() }).strict();
const VoidSchema = z.unknown().transform(() => undefined);

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export const FAMILY_ERROR_CODES = [
  'offline',
  'busy',
  'not_eligible',
  'invalid_name',
  'invalid_code',
  'family_full',
  'already_member',
  'too_many',
  'not_in_family',
  'not_admin',
  'sharing_off',
  'disclosure_required',
  'invalid_place',
  'too_many_places',
  'unknown',
] as const;
export type FamilyErrorCode = (typeof FAMILY_ERROR_CODES)[number];

/** A family call that did not succeed, as a code the screens word (never the server's text). */
export class FamilyError extends Error {
  override readonly name = 'FamilyError';
  constructor(readonly code: FamilyErrorCode, readonly cause?: unknown) {
    super(`family: ${code}`);
  }
}

/** Every fixed message 0012's RPCs raise or return, each to its code. */
export const FAMILY_ERROR_MESSAGES: Readonly<Record<string, FamilyErrorCode>> = {
  'account not eligible': 'not_eligible',
  'invalid name': 'invalid_name',
  'invalid code': 'invalid_code',
  'family is full': 'family_full',
  'already in a family': 'already_member',
  'too many attempts': 'too_many',
  'not in a family': 'not_in_family',
  'not in your family': 'not_in_family',
  'only the family admin can remove a member': 'not_admin',
  'only the family admin can change the code': 'not_admin',
  'use leave_family to leave': 'unknown',
  'location sharing is off': 'sharing_off',
  'location disclosure required': 'disclosure_required',
  'invalid location': 'unknown',
  'invalid value': 'unknown',
  'invalid place': 'invalid_place',
  'too many places': 'too_many_places',
};

const LOCK_TIMEOUT_SQLSTATE = '55P03';

export function familyErrorCode(error: unknown, status: number): FamilyErrorCode {
  if (status === 0) return 'offline';
  if (typeof error !== 'object' || error === null) return 'unknown';
  const { code: sqlstate, message } = error as { code?: unknown; message?: unknown };
  if (sqlstate === LOCK_TIMEOUT_SQLSTATE) return 'busy';
  if (typeof message === 'string') return FAMILY_ERROR_MESSAGES[message] ?? 'unknown';
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------------------------

/** The slice of the Supabase client these calls use; a test passes a fake. */
export type FamilyClient = Pick<typeof AppClient, 'rpc'>;

/** The app client, loaded on first call rather than at import (a screen test never needs its env). */
function appClient(): FamilyClient {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- the app client, only when used
  return (require('@/data/supabase/client') as typeof import('@/data/supabase/client')).supabase;
}

interface Reply {
  data: unknown;
  error: unknown;
  status: number;
}

async function callRpc<T>(reply: PromiseLike<Reply>, schema: z.ZodType<T>): Promise<T> {
  let answer: Reply;
  try {
    answer = await reply;
  } catch (error) {
    // supabase-js answers a failed fetch as `status: 0`; a throw is the same thing.
    throw new FamilyError('offline', error);
  }
  if (answer.error) throw new FamilyError(familyErrorCode(answer.error, answer.status), answer.error);
  const parsed = schema.safeParse(answer.data);
  if (!parsed.success) throw new FamilyError('unknown', parsed.error.issues);
  return parsed.data;
}

export interface PlaceInput {
  /** Absent: a new place. */
  id?: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  radiusM: number;
}

export interface LocationInput {
  lat: number;
  lng: number;
  accuracyM: number;
  driving: boolean;
}

/** The calls the hooks make, as one injectable object. */
export interface FamilyApi {
  fetchSnapshot(): Promise<FamilySnapshot>;
  createFamily(name: string): Promise<string>;
  /** Normalised first; anything that cannot match `FAMILY_CODE_PATTERN` is refused with no request. */
  joinFamily(code: string): Promise<string>;
  leaveFamily(): Promise<void>;
  removeMember(userId: string): Promise<void>;
  rotateCode(): Promise<string>;
  setSharing(on: boolean): Promise<void>;
  postLocation(location: LocationInput): Promise<boolean>;
  savePlace(place: PlaceInput): Promise<string>;
  deletePlace(id: string): Promise<void>;
}

export function createFamilyApi(client: () => FamilyClient = appClient): FamilyApi {
  const rpc = (fn: string, args?: Record<string, unknown>) => client().rpc(fn as never, args as never) as unknown as PromiseLike<Reply>;
  return {
    fetchSnapshot: () => callRpc(rpc('family_snapshot'), FamilySnapshotSchema),
    createFamily: async (name) => (await callRpc(rpc('create_family', { p_name: name }), FamilyIdSchema)).familyId,
    joinFamily: async (input) => {
      const code = normaliseFamilyCode(input);
      if (!FAMILY_CODE_PATTERN.test(code)) throw new FamilyError('invalid_code');
      return (await callRpc(rpc('join_family', { p_code: code }), FamilyIdSchema)).familyId;
    },
    leaveFamily: () => callRpc(rpc('leave_family'), VoidSchema),
    removeMember: (userId) => callRpc(rpc('remove_family_member', { p_user: userId }), VoidSchema),
    rotateCode: async () => (await callRpc(rpc('rotate_family_code'), CodeAnswerSchema)).code,
    setSharing: (on) => callRpc(rpc('set_location_sharing', { p_on: on }), VoidSchema),
    postLocation: async (l) =>
      (
        await callRpc(
          rpc('post_my_location', { p_lat: l.lat, p_lng: l.lng, p_accuracy_m: l.accuracyM, p_driving: l.driving }),
          PostAnswerSchema
        )
      ).accepted,
    savePlace: async (p) =>
      (
        await callRpc(
          rpc('save_family_place', {
            p_id: p.id ?? null,
            p_name: p.name,
            p_address: p.address,
            p_lat: p.lat,
            p_lng: p.lng,
            p_radius_m: p.radiusM,
          }),
          PlaceIdSchema
        )
      ).id,
    deletePlace: (id) => callRpc(rpc('delete_family_place', { p_id: id }), VoidSchema),
  };
}

export const defaultFamilyApi: FamilyApi = createFamilyApi();
