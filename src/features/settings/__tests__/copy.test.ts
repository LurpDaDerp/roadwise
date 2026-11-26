import { APPEARANCE_CHOICES } from '@/ui/appearance';

import { settingsCopy, shownVisibility, VISIBILITY_LABEL, VISIBILITY_SEGMENTS } from '../copy';

describe('heat-map visibility', () => {
  it('offers Only me and Friends', () => {
    expect(VISIBILITY_SEGMENTS).toEqual([
      { value: 'only_me', label: 'Only me' },
      { value: 'friends', label: 'Friends' },
    ]);
  });

  it('labels both choices', () => {
    expect(VISIBILITY_LABEL).toEqual({ only_me: 'Only me', friends: 'Friends' });
  });

  it('shows only_me and friends as themselves, and nothing while unknown', () => {
    expect(shownVisibility('only_me')).toBe('only_me');
    expect(shownVisibility('friends')).toBe('friends');
    expect(shownVisibility(null)).toBeNull();
    expect(shownVisibility(undefined)).toBeNull();
  });
});

describe('Appearance', () => {
  it('names every choice with one plain line, no dashes', () => {
    const options = settingsCopy.root.appearance.options;
    expect(Object.keys(options).sort()).toEqual([...APPEARANCE_CHOICES].sort());
    expect(options.adaptive).toEqual({ label: 'Adaptive', detail: 'Follows the time of day and the weather' });
    for (const o of Object.values(options)) expect(`${o.label} ${o.detail}`).not.toMatch(/[–—]/);
  });
});

describe('the rest of the settings words', () => {
  it('Privacy says who sees what, and that phone pickups are felt, never seen', () => {
    expect(settingsCopy.root.privacyFooter).toBe(
      "Only your friends can see what you share here. The heat map shows the roads you drive most. RoadWise can tell when you pick up your phone on a drive, but it never sees what's on your screen, your apps, or your messages."
    );
  });

  it('Privacy zones say what a zone cuts: the uploaded copy of drives recorded after it, never your own maps or share cards', () => {
    const z = settingsCopy.zones;
    expect(z.intro).toBe(
      'RoadWise cuts routes inside a zone from the copy of each drive it uploads, so friends and the heat map never get them. A zone applies to drives recorded after you add it.'
    );
    expect(z.trim).toBe('RoadWise also cuts the first and last quarter mile of every drive from the upload. Your own maps and share cards show the whole route.');
    expect(z.removeBody).toBe(
      'Drives recorded after this will upload routes near this place, so friends and the heat map can get them. Drives already uploaded stay as they are.'
    );
    // Your maps and share cards draw the whole route, so nothing may say a zone hides it there.
    for (const line of [z.intro, z.trim, z.removeBody]) expect(line).not.toMatch(/hidden on your maps|share cards and heat map|show on your maps again/i);
  });

  it('Automatic drives: on, switched off, and on with what it still needs', () => {
    const a = settingsCopy.root.autoDrives;
    expect(a.on).toBe('On. RoadWise notices your drives.');
    expect(a.disabled).toBe('Off. Swipe Start drive on Home before you pull out.');
    expect(a.needs(a.what.locationAlways)).toBe('On, but it needs Location set to Always.');
    expect(a.fix).toBe('Fix it in Permissions');
    expect(Object.values(a.what)).toEqual(['Location set to Always', 'Precise Location', 'Motion & Fitness', 'Background App Refresh']);
    expect(Object.values(a.whatAndroid)).toEqual([
      'Location set to Allow all the time',
      'Precise location',
      'Physical activity',
      'App battery usage set to Optimized or Unrestricted',
    ]);
  });

  it('deleting the account names the Safety Rating, and no settings words mention points, streaks, freezes, levels or the global board', () => {
    expect(settingsCopy.deleteAccount.consequences[1]).toBe('Your Safety Rating, weekly goals, and achievements');
    const all: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') all.push(v);
      else if (typeof v === 'function') return;
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(settingsCopy);
    for (const line of all) expect(line).not.toMatch(/\bpoints?\b|streak|freeze|\blevel\b|global board|leaderboard|reminder|\bstate\b/i);
  });
});
