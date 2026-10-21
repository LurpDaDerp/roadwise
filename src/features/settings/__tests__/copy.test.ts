import { APPEARANCE_CHOICES } from '@/ui/appearance';

import { settingsCopy, shownVisibility, VISIBILITY_LABEL, VISIBILITY_SEGMENTS } from '../copy';

describe('heat-map visibility', () => {
  it('offers Only me and Friends', () => {
    expect(VISIBILITY_SEGMENTS).toEqual([
      { value: 'only_me', label: 'Only me' },
      { value: 'friends', label: 'Friends' },
    ]);
  });

  it('shows a saved clan as Only me (fails closed, as the server stores it)', () => {
    expect(shownVisibility('clan')).toBe('only_me');
    expect(VISIBILITY_LABEL.clan).toBe('Only me');
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
