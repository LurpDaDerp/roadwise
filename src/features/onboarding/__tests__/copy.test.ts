/** @jest-environment node */
import { onboardingCopy } from '../copy';
import { STEP_IDS } from '../flow';

/** Promises the app never makes: score guarantees, streak pressure, points as money, shouting. */
const BANNED_COPY: readonly RegExp[] = [
  /never lowers|can(no|')t go down|never decays/i,
  /lose your streak|about to lose|hurry|last chance/i,
  /\$|\bcash\b|money|dollars?|gift ?cards?|redeem|prizes?|insurance|discounts?/i,
  /!/,
];

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (typeof value === 'function') return [];
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

describe('onboarding copy', () => {
  const all = strings(onboardingCopy);

  it('names every step', () => {
    for (const id of STEP_IDS) expect(onboardingCopy.stepTitles[id].length).toBeGreaterThan(0);
  });

  it('never asks for an age or a birth date, and Android never asks for Always location', () => {
    for (const s of all) expect(s).not.toMatch(/all the time|birth|\bage\b|guardian|family/i);
    for (const s of strings(onboardingCopy.location.android)) expect(s).not.toMatch(/\balways\b/i);
  });

  it.each(all.map((s) => [s]))('%p makes no banned promise', (s) => {
    for (const banned of BANNED_COPY) expect(s).not.toMatch(banned);
  });

  it('has no points, streaks, reminder or em dash anywhere', () => {
    for (const s of all) {
      expect(s).not.toMatch(/\bpoints?\b|\bpts\b|streak|freeze|reminder|forgot to start|leaderboard/i);
      expect(s).not.toMatch(/\u2014/);
    }
  });

  it('words how drives start for each phone: on their own on an iPhone, from Start drive on Android', () => {
    expect(onboardingCopy.how.rows.ios[0]!.title).toBe('It notices your drives');
    expect(onboardingCopy.how.rows.android[0]!.body).toBe('Swipe Start drive on Home before you pull out. RoadWise records until you park.');
    expect(onboardingCopy.how.rows.ios).toHaveLength(5);
    expect(onboardingCopy.how.rows.android).toHaveLength(5);
    for (const s of strings(onboardingCopy.how.rows.android)) expect(s).not.toMatch(/notices|by itself|on its own|automatic/i);
  });

  it('says on both phones that a phone pickup counts, felt by motion, and that RoadWise never sees the screen, apps or messages', () => {
    for (const rows of [onboardingCopy.how.rows.ios, onboardingCopy.how.rows.android]) {
      expect(rows[3]).toEqual({
        icon: 'phone-portrait-outline',
        title: 'Phone down',
        body: 'Picking up your phone while you drive counts against your score. RoadWise feels it by motion and never sees your screen, apps or messages.',
      });
    }
    expect(onboardingCopy.motion.phone).toBe('Pickups are felt from motion alone. RoadWise never sees your screen, apps or messages.');
  });

  it('says what motion access is for on each phone, and that speed, braking and phone pickups need none', () => {
    expect(onboardingCopy.motion.body.ios).toBe(
      'Motion & Fitness tells driving from walking, so your drives start and end at the right moment. Speed, braking and phone pickups are measured either way.'
    );
    expect(onboardingCopy.motion.body.android).toBe(
      'Lets RoadWise end a drive once you park and walk away. Speed, braking and phone pickups are measured either way.'
    );
    expect(onboardingCopy.motion.denied.android).toBe(
      'Physical activity is off. Drives still record, and one you forget to end stops after 5 min parked. You can turn it on in Settings.'
    );
    for (const s of strings(onboardingCopy.motion)) expect(s).not.toMatch(/hard braking|detect/i);
  });

  it('says why each permission is asked, in one line where it is asked', () => {
    expect(onboardingCopy.location.ios.steps).toBe('Your iPhone asks twice. Choose “Allow While Using App”, then “Change to Always Allow”.');
    expect(onboardingCopy.location.android.body).toBe('RoadWise uses precise location on drives you start, and to check local weather.');
    expect(onboardingCopy.location.ios.approximate).toBe('Location is set to approximate, so drives can’t record. Turn on Precise Location in Settings.');
    expect(onboardingCopy.notifications.body).toBe('Get a recap after each drive, your Sunday summary, and a heads-up when a friend adds you.');
  });
});
