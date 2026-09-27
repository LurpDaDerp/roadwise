import type { Family, FamilyApi, FamilyMember, FamilyPlace, FamilySnapshot, LocationInput, PlaceInput } from '../api';

export const UID = '00000000-0000-4000-8000-00000000000a';
export const OTHER = '00000000-0000-4000-8000-00000000000b';
export const THIRD = '00000000-0000-4000-8000-00000000000c';
export const FAMILY_ID = '00000000-0000-4000-8000-0000000000f1';
export const PLACE_ID = '00000000-0000-4000-8000-0000000000d1';
export const NOW = Date.parse('2026-09-26T12:00:00Z');

export const member = (over: Partial<FamilyMember> = {}): FamilyMember => ({
  userId: OTHER,
  name: 'Sam',
  role: 'member',
  isMe: false,
  sharing: true,
  location: { lat: 47.61, lng: -122.33, accuracyM: 10, driving: false, updatedAt: new Date(NOW - 5 * 60_000).toISOString() },
  ...over,
});

export const me = (over: Partial<FamilyMember> = {}): FamilyMember =>
  member({ userId: UID, name: 'Alex', role: 'admin', isMe: true, sharing: false, location: null, ...over });

export const place = (over: Partial<FamilyPlace> = {}): FamilyPlace => ({
  id: PLACE_ID,
  name: 'Home',
  address: '1 Main St',
  lat: 47.6,
  lng: -122.3,
  radiusM: 150,
  ...over,
});

export const family = (over: Partial<Family> = {}): Family => ({
  id: FAMILY_ID,
  name: 'The Parks',
  myRole: 'admin',
  mySharing: false,
  code: 'ABC234',
  codeExpiresAt: new Date(NOW + 7 * 86_400_000).toISOString(),
  members: [me(), member()],
  places: [],
  ...over,
});

/** A server in memory: the snapshot, and every call recorded (jest mocks). */
export function fakeFamilyApi(initial: FamilySnapshot = { family: null }) {
  const server = { snapshot: initial };
  const api: jest.Mocked<FamilyApi> = {
    fetchSnapshot: jest.fn(async () => server.snapshot),
    createFamily: jest.fn(async (name: string) => {
      server.snapshot = { family: family({ name, members: [me()] }) };
      return FAMILY_ID;
    }),
    joinFamily: jest.fn(async (_code: string) => {
      server.snapshot = { family: family({ myRole: 'member', code: null, codeExpiresAt: null }) };
      return FAMILY_ID;
    }),
    leaveFamily: jest.fn(async () => {
      server.snapshot = { family: null };
    }),
    removeMember: jest.fn(async (userId: string) => {
      const f = server.snapshot.family;
      if (f) server.snapshot = { family: { ...f, members: f.members.filter((m) => m.userId !== userId) } };
    }),
    rotateCode: jest.fn(async () => 'XYZ789'),
    setSharing: jest.fn(async (on: boolean) => {
      const f = server.snapshot.family;
      if (f) server.snapshot = { family: { ...f, mySharing: on, members: f.members.map((m) => (m.isMe ? { ...m, sharing: on } : m)) } };
    }),
    postLocation: jest.fn(async (_l: LocationInput) => true),
    savePlace: jest.fn(async (_p: PlaceInput) => PLACE_ID),
    deletePlace: jest.fn(async (_id: string) => undefined),
  };
  return { api, server };
}
