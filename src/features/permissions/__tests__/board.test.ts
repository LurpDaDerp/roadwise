/** The board: one read of the phone, Home's single row, Settings' list, the fix of a tap and the summary. */
import type { PermissionSnapshot } from '@/core/permissions';

import { snap } from '../__fixtures__/harness';
import { boardRows, fixFor, homeCard, overall, readPermissionBoard, settingsRows, toSettingsApplies, type BoardReadDeps } from '../board';
import { EMPTY_HOME_PREFS, type HomePrefs } from '../homePrefs';
import type { PermissionBoardRead } from '../registry';

function board(over: Partial<PermissionSnapshot> = {}, rest: Partial<Omit<PermissionBoardRead, 'snapshot'>> = {}): PermissionBoardRead {
  const snapshot = snap(over);
  return { snapshot, androidApi: snapshot.platform === 'android' ? 34 : null, paired: false, bluetooth: null, camera: null, ...rest };
}

const prefs = (over: Partial<HomePrefs> = {}): HomePrefs => ({ ...EMPTY_HOME_PREFS, ...over });

const allOff = board({ location: 'undetermined', precise: null, motion: 'undetermined', notifications: 'undetermined' });

describe('homeCard', () => {
  it('nothing missing: no row', () => {
    expect(homeCard(board(), prefs(), false)).toEqual({ row: null, more: 0 });
  });

  it('the first missing row by order, and how many more', () => {
    const card = homeCard(allOff, prefs(), false);
    expect(card.row?.id).toBe('location');
    expect(card.more).toBe(2);
  });

  it('hiding or granting the first reveals the next', () => {
    expect(homeCard(allOff, prefs({ hidden: ['location'] }), false)).toMatchObject({ row: { id: 'motion' }, more: 1 });
    expect(homeCard(board({ motion: 'undetermined', notifications: 'undetermined' }), prefs(), false)).toMatchObject({ row: { id: 'motion' }, more: 1 });
    expect(homeCard(allOff, prefs({ hidden: ['location', 'motion', 'notifications'] }), false)).toEqual({ row: null, more: 0 });
  });

  it('no card while a drive records', () => {
    expect(homeCard(allOff, prefs(), true)).toEqual({ row: null, more: 0 });
  });

  it('never the camera, idle or unknown rows', () => {
    const read = board({ motion: null }, { camera: { access: 'denied', canAskAgain: false } });
    expect(homeCard(read, prefs(), false)).toEqual({ row: null, more: 0 });
  });

  it('a hidden row stays hidden through granted → denied', () => {
    const p = prefs({ hidden: ['motion'] });
    expect(homeCard(board({ motion: 'granted' }), p, false).row).toBeNull();
    expect(homeCard(board({ motion: 'denied' }), p, false).row).toBeNull();
  });
});

describe('fixFor', () => {
  const motionDenied = board({ platform: 'android', motion: 'denied' });
  const state = boardRows(motionDenied).find((r) => r.id === 'motion')!.state;

  it('asks while the phone can, until a request had no effect on this very state', () => {
    expect(fixFor('motion', state, prefs())).toBe('request');
    expect(fixFor('motion', state, prefs({ toSettings: { motion: 'denied:true' } }))).toBe('settings');
  });

  it('a stale signature does not apply', () => {
    expect(fixFor('motion', state, prefs({ toSettings: { motion: 'notYet:true' } }))).toBe('request');
  });

  it('Settings when the phone cannot ask; nothing for a row that is not missing', () => {
    const ios = boardRows(board({ platform: 'ios', motion: 'denied' })).find((r) => r.id === 'motion')!.state;
    expect(fixFor('motion', ios, prefs())).toBe('settings');
    expect(fixFor('motion', { kind: 'granted' }, prefs())).toBeNull();
    expect(fixFor('camera', { kind: 'idle' }, prefs())).toBeNull();
  });
});

describe('toSettingsApplies', () => {
  it('only while the row is still missing with the same signature', () => {
    expect(toSettingsApplies(board({ platform: 'android', motion: 'denied' }), 'motion', 'denied:true')).toBe(true);
    expect(toSettingsApplies(board({ platform: 'android', motion: 'granted' }), 'motion', 'denied:true')).toBe(false);
    expect(toSettingsApplies(board({ platform: 'android', motion: 'undetermined' }), 'motion', 'denied:true')).toBe(false);
  });
});

describe('settingsRows', () => {
  it('iOS lists Location Always and Background App Refresh in order; Android lists neither', () => {
    const ios = settingsRows(board({ platform: 'ios', location: 'always', backgroundRefresh: 'available' }), prefs()).map((r) => r.id);
    expect(ios).toEqual(['location', 'precise', 'locationAlways', 'motion', 'backgroundRefresh', 'notifications', 'bluetooth', 'camera']);
    const android = settingsRows(board({ platform: 'android' }), prefs()).map((r) => r.id);
    expect(android).toEqual(['location', 'precise', 'motion', 'notifications', 'bluetooth', 'camera']);
  });

  it('Background App Refresh is left out when it cannot be read', () => {
    expect(settingsRows(board({ platform: 'ios', backgroundRefresh: null }), prefs()).map((r) => r.id)).not.toContain('backgroundRefresh');
  });

  it('iPhone Home: Location Always, then Background App Refresh, after the rows a drive needs', () => {
    const read = board({ platform: 'ios', location: 'foreground', canAskAlways: true, backgroundRefresh: 'denied', motion: 'undetermined' });
    const card = homeCard(read, prefs(), false);
    expect(card.row?.id).toBe('locationAlways');
    expect(card.more).toBe(2);
    expect(overall(settingsRows(read, prefs()))).toBe('attention');
  });

  it('precise only while location is allowed; motion left out when it cannot be reported', () => {
    const ids = settingsRows(board({ location: 'denied', precise: null, motion: 'unavailable' }), prefs()).map((r) => r.id);
    expect(ids).not.toContain('precise');
    expect(ids).not.toContain('motion');
    expect(ids).toEqual(['location', 'notifications', 'bluetooth', 'camera']);
  });

  it('Hidden from Home only on a hidden row that is missing', () => {
    const p = prefs({ hidden: ['motion', 'notifications'] });
    const rows = settingsRows(board({ motion: 'denied', notifications: 'granted' }), p);
    expect(rows.find((r) => r.id === 'motion')?.hiddenFromHome).toBe(true);
    expect(rows.find((r) => r.id === 'notifications')?.hiddenFromHome).toBe(false);
  });
});

describe('overall', () => {
  it('ok with idle and unknown rows', () => {
    expect(overall(settingsRows(board({ precise: null, motion: null }), prefs()))).toBe('ok');
  });

  it('broken with location, Location Services or precise missing; otherwise attention', () => {
    expect(overall(settingsRows(board({ location: 'denied', precise: null }), prefs()))).toBe('broken');
    expect(overall(settingsRows(board({ platform: 'android', locationServices: false }), prefs()))).toBe('broken');
    expect(overall(settingsRows(board({ precise: false }), prefs()))).toBe('broken');
    expect(overall(settingsRows(board({ notifications: 'denied' }), prefs()))).toBe('attention');
  });
});

describe('with the Automatic drives switch off', () => {
  // An iPhone at While Using that can still ask for Always, with Background App Refresh off.
  const autoOnly = board({ platform: 'ios', location: 'foreground', canAskAlways: true, backgroundRefresh: 'denied' });

  it('switch on: Home asks for Location Always, then Background App Refresh; the summary needs a look', () => {
    expect(homeCard(autoOnly, prefs(), false)).toMatchObject({ row: { id: 'locationAlways' }, more: 1 });
    expect(homeCard(autoOnly, prefs(), false, false)).toMatchObject({ row: { id: 'locationAlways' }, more: 1 });
    expect(overall(settingsRows(autoOnly, prefs()))).toBe('attention');
    expect(settingsRows(autoOnly, prefs()).filter((r) => r.autoOff)).toEqual([]);
  });

  it('switch off: no Home row for Location Always or Background App Refresh, and the summary is ok', () => {
    expect(homeCard(autoOnly, prefs(), false, true)).toEqual({ row: null, more: 0 });
    const bgOnly = board({ platform: 'ios', location: 'always', backgroundRefresh: 'denied' });
    expect(homeCard(bgOnly, prefs(), false)).toMatchObject({ row: { id: 'backgroundRefresh' } });
    expect(homeCard(bgOnly, prefs(), false, true)).toEqual({ row: null, more: 0 });
    const rows = settingsRows(autoOnly, prefs(), true);
    expect(rows.filter((r) => r.autoOff).map((r) => r.id)).toEqual(['locationAlways', 'backgroundRefresh']);
    expect(overall(rows)).toBe('ok');
  });

  it('switch off: Motion and Notifications still ask, and the summary still needs a look for them', () => {
    const read = board({ platform: 'ios', location: 'foreground', canAskAlways: true, backgroundRefresh: 'denied', motion: 'denied', notifications: 'undetermined' });
    expect(homeCard(read, prefs(), false, true)).toMatchObject({ row: { id: 'motion' }, more: 1 });
    expect(overall(settingsRows(read, prefs(), true))).toBe('attention');
  });

  it('switch off: a hidden auto-only row offers no Show on Home', () => {
    const rows = settingsRows(autoOnly, prefs({ hidden: ['locationAlways'] }), true);
    expect(rows.find((r) => r.id === 'locationAlways')).toMatchObject({ autoOff: true, hiddenFromHome: false });
  });
});

describe('readPermissionBoard', () => {
  function deps(over: Partial<BoardReadDeps> = {}) {
    const calls: string[] = [];
    const d: BoardReadDeps = {
      snapshot: async () => {
        calls.push('snapshot');
        return snap({ platform: 'android' });
      },
      androidApi: 33,
      paired: async () => {
        calls.push('paired');
        return false;
      },
      bluetoothPermission: async () => {
        calls.push('bluetoothPermission');
        return 'granted';
      },
      camera: async () => {
        calls.push('camera');
        return { access: 'undetermined', canAskAgain: true };
      },
      ...over,
    };
    return { d, calls };
  }

  it('unpaired: the Bluetooth permission is never read', async () => {
    const { d, calls } = deps();
    const read = await readPermissionBoard(d);
    expect(calls).not.toContain('bluetoothPermission');
    expect(read).toMatchObject({ paired: false, bluetooth: null, androidApi: 33, camera: { access: 'undetermined' } });
  });

  it('paired: it is read', async () => {
    const { d, calls } = deps({ paired: async () => true });
    expect((await readPermissionBoard(d)).bluetooth).toBe('granted');
    expect(calls).toContain('bluetoothPermission');
  });

  it('each extra read failing alone nulls only its own field', async () => {
    const boom = () => Promise.reject(new Error('x'));
    expect(await readPermissionBoard(deps({ camera: boom }).d)).toMatchObject({ camera: null });
    expect(await readPermissionBoard(deps({ paired: boom }).d)).toMatchObject({ paired: false, bluetooth: null });
    expect(await readPermissionBoard(deps({ paired: async () => true, bluetoothPermission: boom }).d)).toMatchObject({ paired: true, bluetooth: null });
  });

  it('a snapshot that fails makes the whole read fail', async () => {
    await expect(readPermissionBoard(deps({ snapshot: () => Promise.reject(new Error('x')) }).d)).rejects.toThrow('x');
  });

  it('iOS has no API level', async () => {
    const { d } = deps({ snapshot: async () => snap({ platform: 'ios' }) });
    expect((await readPermissionBoard(d)).androidApi).toBeNull();
  });
});
