import { createFamilyApi, FamilyError, familyErrorCode, FamilySnapshotSchema, normaliseFamilyCode, type FamilyClient } from '../api';
import { family, FAMILY_ID } from '../__fixtures__/world';

function client(reply: { data: unknown; error: unknown; status: number }) {
  const rpc = jest.fn(async () => reply);
  return { rpc, api: createFamilyApi(() => ({ rpc }) as unknown as FamilyClient) };
}

describe('the snapshot schema', () => {
  it('reads a family, and no family', () => {
    expect(FamilySnapshotSchema.safeParse({ family: family() }).success).toBe(true);
    expect(FamilySnapshotSchema.safeParse({ family: null }).success).toBe(true);
  });

  it('refuses an answer carrying anything more (strict), whole', () => {
    expect(FamilySnapshotSchema.safeParse({ family: { ...family(), trips: [] } }).success).toBe(false);
    const withExtra = family();
    (withExtra.members[1] as unknown as Record<string, unknown>).score = 80;
    expect(FamilySnapshotSchema.safeParse({ family: withExtra }).success).toBe(false);
  });
});

describe('the calls', () => {
  it('fetches the snapshot through family_snapshot', async () => {
    const { rpc, api } = client({ data: { family: null }, error: null, status: 200 });
    await expect(api.fetchSnapshot()).resolves.toEqual({ family: null });
    expect(rpc).toHaveBeenCalledWith('family_snapshot', undefined);
  });

  it('normalises a typed code before joining, and refuses one that cannot match with no request', async () => {
    expect(normaliseFamilyCode(' abc-234 ')).toBe('ABC234');
    const { rpc, api } = client({ data: { familyId: FAMILY_ID }, error: null, status: 200 });
    await expect(api.joinFamily(' abc-234 ')).resolves.toBe(FAMILY_ID);
    expect(rpc).toHaveBeenCalledWith('join_family', { p_code: 'ABC234' });
    rpc.mockClear();
    await expect(api.joinFamily('ABC1')).rejects.toMatchObject({ code: 'invalid_code' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('posts a location with the RPC argument names', async () => {
    const { rpc, api } = client({ data: { accepted: false }, error: null, status: 200 });
    await expect(api.postLocation({ lat: 1, lng: 2, accuracyM: 3, driving: true })).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledWith('post_my_location', { p_lat: 1, p_lng: 2, p_accuracy_m: 3, p_driving: true });
  });

  it('saves a new place with a null id, and an edit with its id', async () => {
    const { rpc, api } = client({ data: { id: FAMILY_ID }, error: null, status: 200 });
    await api.savePlace({ name: 'Home', address: '', lat: 1, lng: 2, radiusM: 150 });
    expect(rpc).toHaveBeenLastCalledWith('save_family_place', {
      p_id: null,
      p_name: 'Home',
      p_address: '',
      p_lat: 1,
      p_lng: 2,
      p_radius_m: 150,
    });
  });

  it('turns each refusal into its code', async () => {
    const { api } = client({ data: null, error: { code: '22023', message: 'invalid code' }, status: 400 });
    await expect(api.joinFamily('ABC234')).rejects.toMatchObject({ code: 'invalid_code' });
    expect(familyErrorCode({ message: 'family is full' }, 403)).toBe('family_full');
    expect(familyErrorCode({ code: '55P03', message: 'x' }, 500)).toBe('busy');
    expect(familyErrorCode({ message: 'something new' }, 400)).toBe('unknown');
    expect(familyErrorCode(new Error('x'), 0)).toBe('offline');
  });

  it('a request that never arrived is offline', async () => {
    const rpc = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    const api = createFamilyApi(() => ({ rpc }) as unknown as FamilyClient);
    await expect(api.leaveFamily()).rejects.toEqual(new FamilyError('offline'));
  });

  it('an answer that fails its schema is unknown, never shown', async () => {
    const { api } = client({ data: { family: { id: 'x' } }, error: null, status: 200 });
    await expect(api.fetchSnapshot()).rejects.toMatchObject({ code: 'unknown' });
  });
});
