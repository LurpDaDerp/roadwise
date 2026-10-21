/** @jest-environment node */
// The Swift half of live-drive (the Expo module and the widget extension target) cannot be compiled
// here, so this suite pins what can be checked as text: the bridge surface, adoption instead of
// replacement, the push-to-start token, the one rule that the ActivityAttributes type is
// byte-identical in the app and the widget (ActivityKit matches them by type), the iOS 16.2 and 17.2
// gates, and the widget's surfaces, sizes, sign styles, copy, weather and tap.
import { LIVE_DRIVE_EVENTS, LIVE_DRIVE_METHODS } from '../src/types';

declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the root tsconfig has no Node types
const fs = require('node:fs') as {
  existsSync: (file: string) => boolean;
  readdirSync: (dir: string) => string[];
  readFileSync: (file: string, encoding: 'utf8') => string;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports -- ditto
const path = require('node:path') as { join: (...parts: string[]) => string };

const MODULE_DIR = path.join(__dirname, '..');
const IOS_DIR = path.join(MODULE_DIR, 'ios');
const WIDGET_DIR = path.join(MODULE_DIR, '..', '..', 'targets', 'live-drive-widget');
const ROOT = path.join(MODULE_DIR, '..', '..');

const read = (dir: string, f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
/** Swift source with `//` line comments removed. */
const code = (dir: string, f: string) =>
  read(dir, f)
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

/** `LiveDriveState` (src/types.ts) as Swift declares it, in order. */
const CONTENT_FIELDS = [
  'speed: Double?',
  'limit: Double?',
  'unit: String',
  'speedTint: String?',
  'speeding: Bool',
  'notDrivingAvailable: Bool',
  'weatherKind: String?',
  'weatherText: String?',
  'skyTop: String?',
  'skyMid: String?',
  'skyLow: String?',
  'accent: String?',
];

describe('live-drive: the Expo module (iOS)', () => {
  const module = () => code(IOS_DIR, 'LiveDriveModule.swift');
  const ctrl = () => code(IOS_DIR, 'LiveDriveController.swift');

  it('is registered for Apple only, under the name the JS wrapper requires, with its launch hook', () => {
    const config = JSON.parse(read(MODULE_DIR, 'expo-module.config.json'));
    expect(config.platforms).toEqual(['apple']);
    expect(config.apple.modules).toEqual(['LiveDriveModule']);
    expect(config.apple.appDelegateSubscribers).toEqual(['LiveDriveAppDelegate']);
    expect(module()).toMatch(/Name\("LiveDrive"\)/);
    const d = code(IOS_DIR, 'LiveDriveAppDelegate.swift');
    expect(d).toMatch(/public class LiveDriveAppDelegate: ExpoAppDelegateSubscriber \{/);
    expect(d).toMatch(/didFinishLaunchingWithOptions[\s\S]*LiveDriveController\.shared\.adoptRunning\(\)\s*\}\s*return true/);
  });

  it('declares one AsyncFunction per LIVE_DRIVE_METHODS entry, and exactly LIVE_DRIVE_EVENTS', () => {
    const declared = [...module().matchAll(/AsyncFunction\("([^"]+)"\)/g)].map((x) => x[1]);
    expect([...declared].sort()).toEqual([...LIVE_DRIVE_METHODS].sort());
    const events = [...(module().match(/Events\(([^)]*)\)/)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(events).toEqual([...LIVE_DRIVE_EVENTS]);
    expect(module()).toMatch(/self\?\.sendEvent\("pushToStartToken", \["token": hex\]\)/);
  });

  it('gates every ActivityKit use on iOS 16.2; the token stream on iOS 17.2', () => {
    const src = module();
    expect(src.match(/#available\(iOS 16\.2, \*\)/g)?.length).toBeGreaterThanOrEqual(7);
    expect(ctrl()).toMatch(/@available\(iOS 16\.2, \*\)\s*final class LiveDriveController/);
    expect(ctrl()).toMatch(/if #available\(iOS 17\.2, \*\) \{\s*tokenTask = Task \{ @MainActor \[weak self\] in\s*for await data in Activity<LiveDriveAttributes>\.pushToStartTokenUpdates \{/);
    expect(ctrl()).toMatch(/let hex = data\.map \{ String\(format: "%02x", \$0\) \}\.joined\(\)\s*UserDefaults\.standard\.set\(hex, forKey: LiveDriveController\.tokenKey\)/);
    expect(ctrl()).toMatch(/static let tokenKey = "livedrive\.pushToStartToken"/);
    expect(ctrl().match(/pushToStartTokenUpdates/g)).toHaveLength(1);
  });

  it('module creation and launch ADOPT a running activity while a drive is open and never end them all', () => {
    expect(module()).toMatch(/OnCreate \{[\s\S]*?controller\.adoptRunning\(\)/);
    const all = code(IOS_DIR, 'LiveDriveModule.swift') + ctrl() + code(IOS_DIR, 'LiveDriveAppDelegate.swift');
    expect(all).not.toMatch(/endAll/);
    const adopt = /func adoptRunning\(\) \{[\s\S]*?\n {2}\}/.exec(ctrl())?.[0] ?? '';
    expect(adopt).toMatch(/let keep = LiveDriveController\.driveOpen \? all\.first\(where: LiveDriveController\.live\) : nil/);
    expect(adopt).toMatch(/for a in all where a\.id != keep\?\.id/);
    expect(ctrl()).toMatch(/static let captureOpenKey = "drivesense\.captureOpen"/);
    // a push-started activity is picked up from activityUpdates
    expect(ctrl()).toMatch(/for await a in Activity<LiveDriveAttributes>\.activityUpdates \{\s*self\?\.adopt\(a\)/);
  });

  it('start updates a running activity instead of replacing it; one request in all; update and end are no-ops without one', () => {
    const c = ctrl();
    expect(c.match(/Activity\.request\(/g)).toHaveLength(1);
    const start = /func start\([\s\S]*?\n {2}\}/.exec(c)?.[0] ?? '';
    expect(start).toMatch(/if activity != nil \{\s*update\(state\)\s*return true\s*\}/);
    expect(start.indexOf('update(state)')).toBeLessThan(start.indexOf('Activity.request('));
    expect(start).toMatch(/pushType: nil/);
    expect(c).toMatch(/func update\([\s\S]{0,80}guard let a = activity else \{ return \}/);
    expect(c).toMatch(/func end\(\) \{\s*guard let a = activity else \{ return \}/);
    expect(c).toMatch(/dismissalPolicy: \.immediate/);
    expect(c).toMatch(/func isRunning\(\) -> Bool \{/);
  });

  it('every content carries a stale date, and the widget blanks a stale state (review I1)', () => {
    const c = ctrl();
    expect(c).toMatch(/STALE_AFTER_S: TimeInterval = 120/);
    expect(c).toContain('staleDate: Date().addingTimeInterval(STALE_AFTER_S)');
    expect(c).not.toMatch(/staleDate: nil/);
    expect(c.match(/LiveDriveController\.content\(state\)/g)).toHaveLength(2);
  });

  it('a running activity takes the "Recording your drive" note down, and every change is announced to drive-sense', () => {
    const c = ctrl();
    expect(c).toMatch(/static let recordingNoteId = "roadwise\.driveRecording"/);
    const note = code(path.join(ROOT, 'modules', 'drive-sense', 'ios'), 'DriveNotifier.swift');
    expect(note).toMatch(/static let identifier = "roadwise\.driveRecording"/);
    expect(c).toMatch(/removeDeliveredNotifications\(withIdentifiers: \[LiveDriveController\.recordingNoteId\]\)/);
    expect(c).toMatch(/static let stateNotification = Notification\.Name\("roadwise\.liveActivity"\)/);
    expect(note).toMatch(/Notification\.Name\("roadwise\.liveActivity"\)/);
    expect(c).toMatch(/didSet \{\s*if activity\?\.id != oldValue\?\.id \{ announce\(\) \}/);
    expect(c).toMatch(/userInfo: \["running": activity != nil\]/);
    expect(read(IOS_DIR, 'LiveDrive.podspec')).toContain("s.frameworks = 'UserNotifications'");
  });

  it('listens for drive-sense setDriveDisplay (roadwise.driveDisplay) and maps every key to the content state', () => {
    const c = ctrl();
    expect(c).toMatch(/Notification\.Name\("roadwise\.driveDisplay"\)/);
    const bridge = code(path.join(ROOT, 'modules', 'drive-sense', 'ios'), 'DriveSenseModule.swift');
    expect(bridge).toMatch(/Notification\.Name\("roadwise\.driveDisplay"\)/);
    expect(c).toMatch(/if info\["ended"\] as\? Bool == true \{\s*self\.end\(\)/);
    expect(bridge).toMatch(/static func postEnded\(\)[\s\S]{0,160}"ended": true/);
    for (const k of ['speed', 'limit', 'unit', 'speeding', 'notDrivingAvailable', 'speedTint', 'weatherKind', 'weatherText', 'skyTop', 'skyMid', 'skyLow', 'accent']) {
      expect(c).toContain(`"${k}"`);
      expect(bridge).toContain(`"${k}"`);
    }
    for (const k of ['speedTint', 'weatherKind', 'weatherText', 'skyTop', 'skyMid', 'skyLow', 'accent']) expect(c).toContain(`${k}: text("${k}")`);
    expect(c).not.toMatch(/points|pointsDelta|stopped/);
  });

  it('the bridge record carries every field into the content state', () => {
    const src = module();
    const record = /struct LiveDriveStateRecord: Record \{([\s\S]*?)\n {2}@available/.exec(src)?.[1] ?? '';
    const fields = [...record.matchAll(/@Field var (\w+): ([\w?]+)/g)].map((m) => `${m[1]}: ${m[2]}`);
    expect(fields).toEqual(CONTENT_FIELDS);
    for (const k of ['speedTint', 'speeding', 'notDrivingAvailable', 'weatherKind', 'weatherText', 'skyTop', 'skyMid', 'skyLow', 'accent']) expect(src).toContain(`${k}: ${k}`);
  });

  it('the podspec links ActivityKit weakly (iOS 15.1 minimum stays)', () => {
    const podspec = read(IOS_DIR, 'LiveDrive.podspec');
    expect(podspec).toContain("s.weak_frameworks = 'ActivityKit'");
    expect(podspec).toContain("s.platforms      = { :ios => '15.1' }");
  });
});

describe('live-drive: the shared attributes', () => {
  it('LiveDriveAttributes.swift is byte-identical in the module and the widget', () => {
    expect(read(WIDGET_DIR, 'LiveDriveAttributes.swift')).toBe(read(IOS_DIR, 'LiveDriveAttributes.swift'));
  });

  it('the content state mirrors LiveDriveState field for field (weather included, no points), and startedAt is epoch ms', () => {
    const src = code(IOS_DIR, 'LiveDriveAttributes.swift');
    expect(src).toMatch(/struct LiveDriveAttributes: ActivityAttributes/);
    const state = /struct ContentState: Codable, Hashable \{([\s\S]*?)\n {2}\}/.exec(src)?.[1] ?? '';
    const fields = [...state.matchAll(/var (\w+): ([\w?]+)/g)].map((m) => `${m[1]}: ${m[2]}`);
    expect(fields).toEqual(CONTENT_FIELDS);
    expect(src).toMatch(/var startedAt: Double\n/);
    expect(src).not.toMatch(/points|pointsDelta|stopped/);
  });
});

describe('live-drive: the widget extension target', () => {


  it('is a widget target at iOS 16.2 with SwiftUI, WidgetKit and ActivityKit, navy/gold until the app sends its sky', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the target config is CommonJS by the plugin's rule
    const cfg = require(path.join(WIDGET_DIR, 'expo-target.config.js')) as Record<string, unknown>;
    expect(cfg.type).toBe('widget');
    expect(cfg.deploymentTarget).toBe('16.2');
    expect(cfg.frameworks).toEqual(['SwiftUI', 'WidgetKit', 'ActivityKit']);
    expect(cfg.colors).toMatchObject({ $widgetBackground: '#001D3D', $accent: '#FFC300' });
    expect(read(WIDGET_DIR, 'Info.plist')).toContain('com.apple.widgetkit-extension');
  });

  it('renders the four surfaces: lock screen, expanded island, compact, minimal', () => {
    const src = code(WIDGET_DIR, 'LiveDriveWidgetBundle.swift');
    expect(src).toMatch(/@main\s*struct LiveDriveWidgetBundle: WidgetBundle/);
    expect(src).toMatch(/ActivityConfiguration\(for: LiveDriveAttributes\.self\)/);
    for (const region of ['.leading', '.trailing']) expect(src).toContain(`DynamicIslandExpandedRegion(${region})`);
    expect(src).toMatch(/compactLeading: \{/);
    expect(src).toMatch(/compactTrailing: \{/);
    expect(src).toMatch(/minimal: \{/);
    // the speed and the limit only: no points anywhere
    expect(src).not.toMatch(/points|DynamicIslandExpandedRegion\(\.bottom\)/i);
    expect(src).toContain('SpeedBlock(speed: state.speed, unit: state.unit, size: 52)');
    expect(src).toContain('LimitSign(limit: state.limit, size: 56)');
    // "-" for an unknown speed or limit
    expect(src).toMatch(/guard let v = v, v\.isFinite else \{ return "-" \}/);
    // the palette
    expect(src).toMatch(/red: 0 \/ 255, green: 29 \/ 255, blue: 61 \/ 255/);
    expect(src).toMatch(/red: 255 \/ 255, green: 195 \/ 255, blue: 0 \/ 255/);
    // nothing interactive
    expect(src).not.toMatch(/Button\(|Link\(|widgetURL/);
  });

  it("wears the app's sky: the lock screen's gradient, its tint, the island's keyline; navy and gold without it", () => {
    const src = code(WIDGET_DIR, 'LiveDriveWidgetBundle.swift');
    // "#RRGGBB" only; anything else (or nil) is no colour
    expect(src).toMatch(/init\?\(hex: String\?\) \{\s*guard let hex = hex, hex\.count == 7, hex\.hasPrefix\("#"\) else \{ return nil \}/);
    expect(src).toMatch(/allSatisfy\(\{ \$0\.isHexDigit \}\), let n = UInt32\(digits, radix: 16\) else \{ return nil \}/);
    // the gradient only with all three stops, top to bottom; navy otherwise
    expect(src).toMatch(
      /if let top = Color\(hex: state\.skyTop\), let mid = Color\(hex: state\.skyMid\), let low = Color\(hex: state\.skyLow\) \{\s*LinearGradient\(colors: \[top, mid, low\], startPoint: \.top, endPoint: \.bottom\)\s*\} else \{\s*Palette\.navy\s*\}/
    );
    expect(src).toMatch(/\.background \{ ground \}/);
    expect(src).toContain('.activityBackgroundTint(Color(hex: state.skyMid) ?? Palette.navy)');
    expect(src).toContain('.keylineTint(Color(hex: state.accent) ?? Palette.gold)');
    // the limit sign's ring is the driving screen's red
    expect(src).toMatch(/signRed = Color\(red: 215 \/ 255, green: 38 \/ 255, blue: 61 \/ 255\)/);
    expect(src).toContain('Circle().strokeBorder(Palette.signRed,');
  });
});

describe('live-drive: app config wiring', () => {
  it('app.config.ts loads the apple-targets plugin and declares NSSupportsLiveActivities', () => {
    const src = fs.readFileSync(path.join(ROOT, 'app.config.ts'), 'utf8');
    expect(src).toMatch(/'@bacons\/apple-targets'/);
    expect(src).toMatch(/NSSupportsLiveActivities: true/);
    expect(src).toMatch(/appleTeamId/);
  });

  it('@bacons/apple-targets is a dev dependency (SDK 57-compatible: peer expo >= 52)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.devDependencies['@bacons/apple-targets']).toBeDefined();
    const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', '@bacons', 'apple-targets', 'package.json'), 'utf8'));
    expect(plugin.peerDependencies.expo).toBe('>=52');
  });
});
