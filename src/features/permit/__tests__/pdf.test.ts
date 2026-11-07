/**
 * The printed log (its page: who, where, when, every drive oldest first, totals, progress, the
 * night rule in words, signature lines, the footer; names made safe) and its trip to the share
 * sheet (a PDF, deleted after); and finding the state from the phone's position.
 */
import { drive, HOUR, NOW } from '@/features/drives/__fixtures__/drives';
import { dayKey } from '@/lib/time';

import { practiceLog } from '../log';
import { escapeHtml, practiceLogHtml, sharePracticeLog, type PracticeLogDoc } from '../pdf';
import { DEFAULT_PERMIT, type PermitPrefs } from '../prefs';
import { detectState, stateAt } from '../stateAt';
import { stateByCode } from '../states';

const prefs: PermitPrefs = { ...DEFAULT_PERMIT, enabled: true, startDay: dayKey(new Date(NOW - 30 * 86_400_000)), state: { code: 'CA', auto: true }, supervisor: 'Dad' };
const log = practiceLog(
  [drive(), drive({ clientTripId: 'b', startedAt: NOW - 5 * HOUR, endedAt: NOW - 5 * HOUR + 30 * 60_000, durationS: 1800, miles: 9.5, practiceSupervisor: 'Mom <3' })],
  prefs
);
const doc = (over: Partial<PracticeLogDoc> = {}): PracticeLogDoc => ({
  log,
  startDay: prefs.startDay ?? '',
  now: NOW,
  state: stateByCode('CA'),
  rule: 'dark30',
  targets: { totalH: 50, nightH: 10 },
  driverName: 'Sam & Co',
  units: 'mi',
  ...over,
});

describe('the page', () => {
  test('title, driver, state, period, the columns and every drive oldest first with its supervisor', () => {
    const html = practiceLogHtml(doc());
    expect(html).toContain('<h1>Supervised driving log</h1>');
    expect(html).toContain('Sam &amp; Co');
    expect(html).toContain('California');
    expect(html).toMatch(/Period<\/th><td>\w{3} \d{1,2}, 2026 to Oct 5, 2026/);
    for (const c of ['Date', 'Start', 'End', 'Duration', 'Day min', 'Night min', 'Miles', 'Supervisor']) expect(html).toContain(`<th>${c}</th>`);
    expect(html.indexOf('Mom &lt;3')).toBeLessThan(html.indexOf('>Dad<'));
    expect(html).not.toContain('Mom <3');
    expect(html).toContain('<td>9.5</td>');
  });

  test('totals, progress against the targets, the night rule in words, signatures and the footer', () => {
    const html = practiceLogHtml(doc());
    expect(html).toMatch(/class="totals"><td>Totals<\/td><td><\/td><td><\/td><td>54 min<\/td><td>54<\/td><td>0<\/td><td>21.5<\/td>/);
    expect(html).toContain('<td>Day</td><td>0.9 of 40 h</td>');
    expect(html).toContain('<td>Night</td><td>0.0 of 10 h</td>');
    expect(html).toContain('<td>Total</td><td>0.9 of 50 h</td>');
    expect(html).toContain('Night = 30 minutes after sunset to 30 minutes before sunrise (California)');
    for (const s of ['Supervisor', 'Driver', 'Date']) expect(html).toContain(`<div class="line"></div>${s}</div>`);
    expect(html).toContain('Recorded by RoadWise. Some states require their own form; copy these hours onto it if so.');
  });

  test('without a night target only the total; without a state or name, none; in km; with no drives, a line saying so', () => {
    const html = practiceLogHtml(doc({ targets: { totalH: null, nightH: null }, state: null, rule: 'sunset', driverName: null, units: 'km', log: { rows: [], totals: { drives: 0, dayMin: 0, nightMin: 0, totalMin: 0, miles: 0 } } }));
    expect(html).not.toContain('<td>Day</td>');
    expect(html).toContain('<td>Total</td><td>0.0 h</td>');
    expect(html).toContain('State</th><td>Not set');
    expect(html).not.toContain('Driver</th>');
    expect(html).toContain('<th>km</th>');
    expect(html).toContain('No practice drives yet.');
    expect(html).toContain('Night = sunset to sunrise</p>');
    expect(practiceLogHtml(doc({ rule: 'md30', state: stateByCode('MD') }))).toContain('Night = 30 minutes before sunset to 30 minutes after sunrise (Maryland)');
  });

  test('escapes what it prints', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    const marked = practiceLog([drive({ practiceSupervisor: '"><img src=x>' })], prefs);
    const html = practiceLogHtml(doc({ driverName: '<b>Al</b>', log: marked }));
    expect(html).toContain('<td>&lt;b&gt;Al&lt;/b&gt;</td>');
    expect(html).toContain('<td>&quot;&gt;&lt;img src=x&gt;</td>');
    expect(html).not.toContain('<b>Al</b>');
    expect(html).not.toContain('<img');
  });

  test("each drive's date and times are its own local ones, as the log counts it", () => {
    // 11:30 PM to 12:10 AM in Los Angeles: the next morning in UTC.
    const startedAt = Date.parse('2026-10-05T06:30:00Z');
    const late = drive({ clientTripId: 'la', startedAt, endedAt: startedAt + 40 * 60_000, durationS: 2400, tz: 'America/Los_Angeles' });
    const html = practiceLogHtml(doc({ log: practiceLog([late], { ...prefs, startDay: '2026-10-01' }) }));
    expect(html).toContain('<td>Oct 4, 2026</td><td>11:30 PM</td><td>12:10 AM</td>');
    const elsewhere = drive({ clientTripId: 'ny', startedAt, endedAt: startedAt + 40 * 60_000, durationS: 2400, tz: 'America/New_York' });
    expect(practiceLogHtml(doc({ log: practiceLog([elsewhere], { ...prefs, startDay: '2026-10-01' }) }))).toContain('<td>Oct 5, 2026</td><td>2:30 AM</td><td>3:10 AM</td>');
  });
});

describe('the share sheet', () => {
  test('prints, shares a PDF, then deletes the file', async () => {
    const calls: string[] = [];
    const ok = await sharePracticeLog('<p>log</p>', {
      isAvailable: async () => true,
      print: async (html) => (calls.push(`print ${html}`), { uri: 'file:///log.pdf' }),
      share: async (uri, opts) => calls.push(`share ${uri} ${opts.mimeType} ${opts.UTI}`),
      remove: (uri) => calls.push(`remove ${uri}`),
    });
    expect(ok).toBe(true);
    expect(calls).toEqual(['print <p>log</p>', 'share file:///log.pdf application/pdf com.adobe.pdf', 'remove file:///log.pdf']);
  });

  test('false when sharing is not available, printing fails or the sheet fails (the file still goes)', async () => {
    const removed: string[] = [];
    const remove = (uri: string) => removed.push(uri);
    expect(await sharePracticeLog('x', { isAvailable: async () => false, remove })).toBe(false);
    expect(await sharePracticeLog('x', { isAvailable: async () => true, print: () => Promise.reject(new Error('no')), remove })).toBe(false);
    expect(await sharePracticeLog('x', { isAvailable: async () => true, print: async () => ({ uri: 'file:///a.pdf' }), share: () => Promise.reject(new Error('no')), remove })).toBe(false);
    expect(removed).toEqual(['file:///a.pdf']);
  });

  test('the defaults: expo-print and expo-sharing', async () => {
    jest.doMock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => true), shareAsync: jest.fn(async () => undefined) }));
    expect(await sharePracticeLog('<p>x</p>', { remove: () => {} })).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the mock the module required
    const Print = require('expo-print') as { printToFileAsync: jest.Mock };
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
    const Sharing = require('expo-sharing') as { shareAsync: jest.Mock };
    expect(Print.printToFileAsync).toHaveBeenCalledWith({ html: '<p>x</p>' });
    expect(Sharing.shareAsync).toHaveBeenCalledWith('file:///cache/Print/practice-log.pdf', { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: 'Your practice log' });
  });
});

describe('the state from the phone', () => {
  const at = { lat: 34.05, lng: -118.24 };

  test("the geocoder's region in the US: an iPhone's code or Android's name", async () => {
    expect((await stateAt(at, async () => [{ isoCountryCode: 'US', region: 'CA' }]))?.code).toBe('CA');
    expect((await stateAt(at, async () => [{ isoCountryCode: 'us', region: 'Texas' }]))?.code).toBe('TX');
  });

  test('none outside the US, with no answer, or on a failure', async () => {
    expect(await stateAt(at, async () => [{ isoCountryCode: 'CA', region: 'ON' }])).toBeNull();
    expect(await stateAt(at, async () => [{ isoCountryCode: 'CA', region: 'WA' }])).toBeNull();
    expect(await stateAt(at, async () => [])).toBeNull();
    expect(await stateAt(at, () => Promise.reject(new Error('offline')))).toBeNull();
  });

  test('from the position the phone already has; none without one', async () => {
    const geocode = jest.fn(async () => [{ isoCountryCode: 'US', region: 'NV' }]);
    expect((await detectState({ position: async () => at, geocode }))?.code).toBe('NV');
    expect(geocode).toHaveBeenCalledWith(at);
    expect(await detectState({ position: async () => null, geocode })).toBeNull();
    expect(await detectState({ position: () => Promise.reject(new Error('denied')), geocode })).toBeNull();
  });
});
