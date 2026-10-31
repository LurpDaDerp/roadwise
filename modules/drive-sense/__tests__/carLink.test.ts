/** @jest-environment node */
// The car link (round 11) as the fake detector plays it, native's rules: pairing takes a current
// output or one a recent drive saw, at most 3 cars, each once, matched on the uid (a renamed car
// shows its new name); "Not my car" is remembered; the wipe empties it all; `carLink` is live only.
// The contract's schema refuses a malformed state.
import { carLinkStateSchema } from '../src/detect';
import { DETECT, carLinked } from '../src/detect/policy';
import type { CarLinkState, CarOutput } from '../src/detect/types';
import { createFakeDriveDetect } from '../src/fakeDetect';

const civic: CarOutput = { uid: '00:11:22:33:44:55-tacl', name: 'Civic', type: 'bluetoothA2DP' };
const carplay: CarOutput = { uid: 'carplay-1', name: 'CarPlay', type: 'carAudio' };
const pods: CarOutput = { uid: 'AA:BB:CC:DD:EE:FF-tacl', name: "Sam's AirPods Pro", type: 'bluetoothA2DP' };

describe('the fake car link', () => {
  test('pairs the current output, links on its uid, and shows its new name after a rename', async () => {
    const d = createFakeDriveDetect();
    d.setCarRoute([civic]);
    expect((await d.carLinkState()).linked).toBe(false);
    const s = await d.pairCar(civic.uid);
    expect(s.cars).toEqual([expect.objectContaining({ uid: civic.uid, name: 'Civic', type: 'bluetoothA2DP' })]);
    expect(s.linked).toBe(true);
    d.setCarRoute([{ ...civic, name: 'Family Civic' }]);
    expect((await d.carLinkState()).cars[0]!.name).toBe('Family Civic');
    d.setCarRoute([]);
    expect((await d.carLinkState()).linked).toBe(false);
    expect(carLinked([civic], ['other'])).toBe(false);
  });

  test('several outputs at once: any paired one links; CarPlay links unpaired', async () => {
    const d = createFakeDriveDetect();
    d.setCarRoute([pods, carplay]);
    expect((await d.carLinkState()).linked).toBe(true);
    d.setCarRoute([pods, civic]);
    await d.pairCar(civic.uid);
    expect((await d.carLinkState()).linked).toBe(true);
  });

  test('pairs an output a recent drive saw (the Home suggestion), never an unknown uid, at most 3 cars, each once', async () => {
    const d = createFakeDriveDetect();
    d.seeCarDrive([civic]);
    expect((await d.pairCar(civic.uid)).cars).toHaveLength(1);
    expect((await d.pairCar(civic.uid)).cars).toHaveLength(1);
    expect((await d.pairCar('nobody')).cars).toHaveLength(1);
    d.setCarRoute([
      { uid: 'b', name: 'B', type: 'bluetoothA2DP' },
      { uid: 'c', name: 'C', type: 'bluetoothLE' },
      { uid: 'e', name: 'E', type: 'bluetoothHFP' },
    ]);
    await d.pairCar('b');
    await d.pairCar('c');
    const full = await d.pairCar('e');
    expect(full.cars.map((c) => c.uid)).toEqual([civic.uid, 'b', 'c']);
    expect(full.cars).toHaveLength(DETECT.CARS_MAX);
    expect((await d.forgetCar('b')).cars.map((c) => c.uid)).toEqual([civic.uid, 'c']);
  });

  test('keeps the last 3 drives; "Not my car" is remembered and pairing it again clears it', async () => {
    const d = createFakeDriveDetect();
    for (let i = 0; i < 5; i++) d.seeCarDrive(i % 2 === 0 ? [civic] : []);
    expect((await d.carLinkState()).drives).toHaveLength(DETECT.CAR_DRIVES_KEPT);
    expect((await d.notMyCar(civic.uid)).notMine).toEqual([civic.uid]);
    expect((await d.notMyCar(civic.uid)).notMine).toEqual([civic.uid]);
    expect((await d.pairCar(civic.uid)).notMine).toEqual([]);
  });

  test('the wipe (sign-out, account switch) forgets the cars, the drives and "Not my car"', async () => {
    const d = createFakeDriveDetect();
    d.setCarRoute([civic]);
    d.seeCarDrive([civic]);
    await d.pairCar(civic.uid);
    await d.notMyCar(pods.uid);
    await d.wipe();
    expect(await d.carLinkState()).toMatchObject({ cars: [], drives: [], notMine: [], current: [civic] });
  });

  test('carLink is live only: heard while listened to, never buffered for a late listener', async () => {
    const d = createFakeDriveDetect();
    d.setCarRoute([civic]);
    const heard: CarLinkState[] = [];
    const sub = d.addListener('carLink', (s) => heard.push(s));
    await Promise.resolve();
    expect(heard).toEqual([]);
    d.setCarRoute([]);
    d.setCarGoneSince(1_760_000_000_000);
    expect(heard.map((s) => s.current.length)).toEqual([0, 0]);
    expect(heard[1]!.goneSince).toBe(1_760_000_000_000);
    sub.remove();
  });

  test('without the module every car-link method rejects', async () => {
    const d = createFakeDriveDetect({ available: false });
    await expect(d.carLinkState()).rejects.toThrow('not available');
    await expect(d.pairCar(civic.uid)).rejects.toThrow('not available');
  });
});

describe('the contract schema', () => {
  const ok: CarLinkState = {
    current: [civic],
    cars: [{ ...civic, pairedAt: 1_760_000_000_000 }],
    linked: true,
    goneSince: null,
    drives: [{ driveId: '0f8fad5b-d9cb-469f-a165-70867728950e', endedAt: 1_760_000_000_000, outputs: [civic] }],
    notMine: [],
  };

  test('takes a full state and refuses a malformed one', () => {
    expect(carLinkStateSchema.safeParse(ok).success).toBe(true);
    expect(carLinkStateSchema.safeParse({ ...ok, current: [{ ...civic, type: 'usbAudio' }] }).success).toBe(false);
    expect(carLinkStateSchema.safeParse({ ...ok, cars: [1, 2, 3, 4].map((i) => ({ ...civic, uid: `u${i}`, pairedAt: 1 })) }).success).toBe(false);
    expect(carLinkStateSchema.safeParse({ ...ok, current: [{ ...civic, uid: '' }] }).success).toBe(false);
    expect(carLinkStateSchema.safeParse({ ...ok, extra: true }).success).toBe(false);
  });
});
