/** The car tally over one drive: connected time, the drive's car, what the route ever held, when the car left. */
import type { CarLinkState, CarOutput, PairedCar } from '@drive-sense';

import { CAR_TAG_SHARE_MIN, createCarTally, nativeCarTag } from '../carTally';

const civic: CarOutput = { uid: 'civic', name: 'Civic', type: 'bluetoothA2DP' };
const rav: CarOutput = { uid: 'rav', name: 'RAV4', type: 'bluetoothHFP' };
const pods: CarOutput = { uid: 'pods', name: 'AirPods', type: 'bluetoothA2DP' };
const carplay: CarOutput = { uid: 'cp', name: '', type: 'carAudio' };
const paired = (o: CarOutput, at = 1): PairedCar => ({ ...o, pairedAt: at });

const state = (current: CarOutput[], cars: PairedCar[] = [paired(civic), paired(rav)], over: Partial<CarLinkState> = {}): CarLinkState => ({
  current,
  cars,
  linked: current.some((o) => o.type === 'carAudio' || cars.some((c) => c.uid === o.uid)),
  goneSince: null,
  drives: [],
  notMine: [],
  ...over,
});

const MIN = 60_000;

describe('the link before the tally began', () => {
  test("native's gone-since in this drive is kept as linkedBefore; it changes nothing else", () => {
    const before = createCarTally(state([], undefined, { goneSince: 5 }), 10 * MIN, 10 * MIN, true);
    expect(before.linkedBefore()).toBe(true);
    expect([before.pairedEver(), before.carPlayEver(), before.audioEver(), before.pairedLeftAt()]).toEqual([false, false, false, null]);
    expect(createCarTally(state([]), 10 * MIN).linkedBefore()).toBe(false);
  });
});

describe('connected time and the drive car', () => {
  test('a car on the route at the open counts from the drive start (a drive that just began)', () => {
    const t = createCarTally(state([civic]), 1 * MIN, 0);
    t.observe(state([]), 10 * MIN);
    expect(t.connectedMs('civic', 0, 10 * MIN)).toBe(10 * MIN);
    expect(t.tag(0, 10 * MIN)).toEqual({ uid: 'civic', name: 'Civic' });
  });

  test('a drive taken up after a relaunch counts only from the open', () => {
    const t = createCarTally(state([civic]), 6 * MIN);
    t.observe(state([]), 10 * MIN);
    expect(t.connectedMs('civic', 0, 10 * MIN)).toBe(4 * MIN);
    // 4 of 10 minutes: under half, no car.
    expect(t.tag(0, 10 * MIN)).toBeNull();
  });

  test('exactly half is enough; just under is not', () => {
    const t = createCarTally(state([]), 0);
    t.observe(state([civic]), 5 * MIN);
    t.observe(state([]), 10 * MIN);
    expect(t.tag(0, 10 * MIN)).toEqual({ uid: 'civic', name: 'Civic' });
    expect(t.tag(0, 10 * MIN + 2)).toBeNull();
    expect(CAR_TAG_SHARE_MIN).toBe(0.5);
  });

  test('the paired car connected longest wins; reconnects add up; time past the end is not counted', () => {
    const t = createCarTally(state([rav]), 0, 0);
    t.observe(state([civic]), 2 * MIN);
    t.observe(state([]), 5 * MIN);
    t.observe(state([civic]), 6 * MIN);
    // Past the drive's end (10 min): does not count.
    t.observe(state([]), 30 * MIN);
    expect(t.connectedMs('rav', 0, 10 * MIN)).toBe(2 * MIN);
    expect(t.connectedMs('civic', 0, 10 * MIN)).toBe(7 * MIN);
    expect(t.tag(0, 10 * MIN)).toEqual({ uid: 'civic', name: 'Civic' });
  });

  test('an output not paired never tags the drive (headphones, an unpaired CarPlay)', () => {
    const t = createCarTally(state([pods, carplay]), 0, 0);
    t.observe(state([]), 10 * MIN);
    expect(t.tag(0, 10 * MIN)).toBeNull();
  });

  test('a car forgotten before the end is no longer the drive car; one paired mid-drive is', () => {
    const t = createCarTally(state([civic], [paired(civic)]), 0, 0);
    t.observe(state([civic], []), 9 * MIN);
    expect(t.tag(0, 10 * MIN)).toBeNull();
    const u = createCarTally(state([civic], []), 0, 0);
    u.observe(state([civic], [paired(civic)]), 1 * MIN);
    expect(u.tag(0, 10 * MIN)).toEqual({ uid: 'civic', name: 'Civic' });
  });

  test('the name is the newest the route gave it; a car with no name reads as its kind', () => {
    const t = createCarTally(state([civic]), 0, 0);
    t.observe(state([{ ...civic, name: "Sam's Civic" }]), 1 * MIN);
    expect(t.tag(0, 2 * MIN)?.name).toBe("Sam's Civic");
    const u = createCarTally(state([carplay], [paired(carplay)]), 0, 0);
    expect(u.tag(0, 2 * MIN)).toEqual({ uid: 'cp', name: 'CarPlay' });
  });

  test('a drive with no length has no car', () => {
    const t = createCarTally(state([civic]), 0, 0);
    expect(t.tag(5, 5)).toBeNull();
    expect(t.connectedMs('civic', 5, 5)).toBe(0);
  });
});

describe('what the route held, and when the car left', () => {
  test('nothing on the route: nothing ever', () => {
    const t = createCarTally(state([]), 0);
    expect([t.pairedNow(), t.pairedEver(), t.carPlayEver(), t.audioEver(), t.audioNow(), t.linkedNow()]).toEqual([false, false, false, false, false, false]);
    expect(t.pairedLeftAt()).toBeNull();
  });

  test('headphones are audio, not a car; an unpaired CarPlay is CarPlay and linked', () => {
    const t = createCarTally(state([]), 0);
    t.observe(state([pods]), 1);
    expect([t.audioEver(), t.audioNow(), t.pairedEver(), t.carPlayEver()]).toEqual([true, true, false, false]);
    t.observe(state([]), 2);
    expect([t.audioEver(), t.audioNow()]).toEqual([true, false]);
    t.observe(state([carplay]), 3);
    expect([t.carPlayEver(), t.linkedNow(), t.pairedNow()]).toEqual([true, true, false]);
  });

  test('the time the last paired car left; a reconnect clears it; one of two leaving is not leaving', () => {
    const t = createCarTally(state([civic, rav]), 0, 0);
    t.observe(state([rav]), 1000);
    expect(t.pairedLeftAt()).toBeNull();
    t.observe(state([]), 2000);
    expect(t.pairedLeftAt()).toBe(2000);
    expect(t.pairedEver()).toBe(true);
    t.observe(state([civic]), 3000);
    expect(t.pairedLeftAt()).toBeNull();
    t.observe(state([pods]), 4000);
    expect(t.pairedLeftAt()).toBe(4000);
    // A repeat of the same route keeps the first time it went.
    t.observe(state([pods]), 5000);
    expect(t.pairedLeftAt()).toBe(4000);
  });
});

describe("native's own record (a drive taken in at a launch)", () => {
  test('the paired car native kept for that drive, by trip or journal id', () => {
    const s = state([], [paired(civic)], { drives: [{ driveId: 'j1', endedAt: 1, outputs: [pods, civic] }] });
    expect(nativeCarTag(s, ['trip', 'j1'])).toEqual({ uid: 'civic', name: 'Civic' });
    expect(nativeCarTag(s, ['other'])).toBeNull();
    expect(nativeCarTag({ ...s, cars: [] }, ['j1'])).toBeNull();
  });
});
