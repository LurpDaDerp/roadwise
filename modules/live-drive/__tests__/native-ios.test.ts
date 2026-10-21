/** @jest-environment node */
// The Swift half of live-drive (the Expo module and the widget extension target) cannot be compiled
// here, so this suite pins what can be checked as text: the bridge surface, adoption instead of
// replacement, the push-to-start token, the one rule that the ActivityAttributes type is
// byte-identical in the app and the widget (ActivityKit matches them by type), the iOS 16.2 and 17.2
// gates, and the widget's surfaces, sizes, sign styles, copy, weather and tap.
import { hudCopy } from '../../../src/features/drive/hudCopy';
import { DANGER_ORDER } from '../../../src/features/weather/danger';
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

  it('a push-started activity is adopted for any background drive (auto, manual, a re-opened leg) unless a live one runs, and adopting it takes the 20 s note down (review I2)', () => {
    const c = ctrl();
    const adopt = /private func adopt\(_ a: Activity<LiveDriveAttributes>\) \{[\s\S]*?\n {2}\}/.exec(c)?.[0] ?? '';
    // only a LIVE held activity refuses it (a dismissed or ended one, the last leg's included, does not)
    expect(adopt).toMatch(/if let current = activity, LiveDriveController\.live\(current\) \{\s*Task \{ await a\.end\(nil, dismissalPolicy: \.immediate\) \}\s*return\s*\}/);
    // any open drive takes it: nothing reads the drive's origin or leg
    expect(adopt).toMatch(/guard LiveDriveController\.driveOpen else \{/);
    expect(c).not.toMatch(/captureMode|origin/);
    expect(adopt).toMatch(/activity = a\s*removeRecordingNote\(\)\s*\}$/);
    // every drive end clears the held activity, so the next leg's pushed one is adopted
    expect(c).toMatch(/if info\["ended"\] as\? Bool == true \{\s*self\.end\(\)/);
    expect(c).toMatch(/func end\(\) \{\s*guard let a = activity else \{ return \}\s*activity = nil/);
    // adopting announces `running`, and drive-sense's note then cancels its 20 s check and comes down
    expect(c).toMatch(/didSet \{\s*if activity\?\.id != oldValue\?\.id \{ announce\(\) \}/);
    const note = code(path.join(ROOT, 'modules', 'drive-sense', 'ios'), 'DriveNotifier.swift');
    expect(note).toMatch(/activityRunning = note\.userInfo\?\["running"\] as\? Bool \?\? false\s*if activityRunning \{\s*cancel\(\)\s*remove\(\)/);
    // the controller (its activityUpdates stream) exists in every process, a background relaunch included
    expect(code(IOS_DIR, 'LiveDriveAppDelegate.swift')).toMatch(/LiveDriveController\.shared\.adoptRunning\(\)/);
  });

  it('an activity the driver dismissed (or iOS ended) is let go, so the next start in front requests a new one (review M8)', () => {
    const c = ctrl();
    expect(c).toMatch(/private static func live\(_ a: Activity<LiveDriveAttributes>\) -> Bool \{\s*a\.activityState == \.active \|\| a\.activityState == \.stale\s*\}/);
    const start = /func start\([\s\S]*?\n {2}\}/.exec(c)?.[0] ?? '';
    expect(start).toMatch(/\{\s*if let a = activity, !LiveDriveController\.live\(a\) \{ activity = nil \}\s*if activity == nil \{ adoptRunning\(\) \}\s*if activity != nil \{\s*update\(state\)/);
    // isRunning answers only for a live one (a dismissed one is replaced by what adoptRunning finds live)
    expect(c).toMatch(/func isRunning\(\) -> Bool \{\s*if let a = activity, LiveDriveController\.live\(a\) \{ return true \}\s*adoptRunning\(\)/);
    const adopt = /func adoptRunning\(\) \{[\s\S]*?\n {2}\}/.exec(c)?.[0] ?? '';
    expect(adopt).toMatch(/all\.first\(where: LiveDriveController\.live\)/);
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
  const widget = () => code(WIDGET_DIR, 'LiveDriveWidgetBundle.swift');
  const view = (name: string) => new RegExp(`struct ${name}: View \\{[\\s\\S]*?\\n\\}`).exec(widget())?.[0] ?? '';

  it('is a widget target at iOS 16.2 with SwiftUI, WidgetKit and ActivityKit, navy/gold until the app sends its sky', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the target config is CommonJS by the plugin's rule
    const cfg = require(path.join(WIDGET_DIR, 'expo-target.config.js')) as Record<string, unknown>;
    expect(cfg.type).toBe('widget');
    expect(cfg.deploymentTarget).toBe('16.2');
    expect(cfg.frameworks).toEqual(['SwiftUI', 'WidgetKit', 'ActivityKit']);
    expect(cfg.colors).toMatchObject({ $widgetBackground: '#001D3D', $accent: '#FFC300' });
    expect(read(WIDGET_DIR, 'Info.plist')).toContain('com.apple.widgetkit-extension');
  });

  it('renders the four surfaces at their sizes: lock screen, expanded island (with its bottom row), compact, minimal', () => {
    const src = widget();
    expect(src).toMatch(/@main\s*struct LiveDriveWidgetBundle: WidgetBundle/);
    expect(src).toMatch(/ActivityConfiguration\(for: LiveDriveAttributes\.self\)/);
    for (const region of ['.leading', '.trailing', '.bottom']) expect(src).toContain(`DynamicIslandExpandedRegion(${region})`);
    const lock = view('LockScreenView');
    expect(lock).toContain('SpeedBlock(state: state, size: 52)');
    expect(lock).toContain('LimitSign(limit: state.limit, unit: state.unit, height: 56)');
    expect(lock).toMatch(/WeatherLine\(state: state\)[\s\S]*NotDrivingHint\(state: state\)/);
    expect(src).toContain('SpeedBlock(state: state, size: 40)');
    expect(src).toContain('LimitSign(limit: state.limit, unit: state.unit, height: 44)');
    expect(src).toMatch(/DynamicIslandExpandedRegion\(\.bottom\) \{\s*HStack\(spacing: 8\) \{\s*WeatherLine\(state: state\)\s*Spacer\(minLength: 0\)\s*NotDrivingHint\(state: state\)/);
    expect(src).toMatch(/compactLeading: \{\s*SpeedNumber\(state: state, size: 15\)/);
    expect(src).toMatch(/compactTrailing: \{\s*LimitSign\(limit: state\.limit, unit: state\.unit, height: 20\)/);
    expect(src).toMatch(/minimal: \{\s*SpeedNumber\(state: state, size: 13\)/);
    // "-" for an unknown speed or limit
    expect(src).toMatch(/guard let v = v, v\.isFinite else \{ return "-" \}/);
  });

  it('no points, no "stopped", nothing interactive; a tap anywhere opens the driving screen', () => {
    const src = widget();
    expect(src).not.toMatch(/points|pointsDelta|stopped/i);
    expect(src).not.toMatch(/Button\(|Link\(|AppIntent|Toggle\(/);
    // (read raw: the comment stripper would cut the URL at its "//")
    expect(read(WIDGET_DIR, 'LiveDriveWidgetBundle.swift')).toMatch(/static let tapURL = URL\(string: "roadwise:\/\/drive"\)/);
    expect(src.match(/\.widgetURL\(Copy\.tapURL\)/g)).toHaveLength(2);
  });

  it("the sign is the driving screen's for the unit: the US plate in mph (0.8 wide, the legend from 30 pt), the round red-ringed sign in km/h", () => {
    const sign = view('LimitSign');
    expect(sign).toMatch(/if unit == "km\/h" \{ roundSign \} else \{ usPlate \}/);
    expect(sign).toMatch(/let w = height \* 0\.8/);
    expect(sign).toMatch(/strokeBorder\(Color\.black, lineWidth: max\(1\.5, w \* 0\.025\)\)/);
    expect(sign).toMatch(/if height >= 30 \{\s*Text\("SPEED"\)\.font\(\.system\(size: height \* 0\.167, weight: \.bold\)\)\s*Text\("LIMIT"\)/);
    expect(sign).toMatch(/size: height \* 0\.46, weight: \.heavy/);
    expect(sign).toContain('Circle().strokeBorder(Palette.signRed, lineWidth: max(2, height * 0.09))');
    expect(sign).toMatch(/size: height \* 0\.42, weight: \.bold/);
    expect(sign).toMatch(/\.accessibilityLabel\(Format\.limitLabel\(limit\)\)/);
  });

  it('an unknown speed reads "-" on the lock screen and in the island, never "0"; a real 0 reads "0" (plan 3.10)', () => {
    const src = widget();
    const format = /enum Format \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    expect(format).toMatch(/static func speed\(_ v: Double\?\) -> String \{\s*guard let v = v, v\.isFinite else \{ return "-" \}\s*return String\(Int\(v\.rounded\(\)\)\)\s*\}/);
    expect(format).not.toMatch(/\?\? 0|v \?\? /);
    // every surface shows the state's own speed through it (the stale state blanks it to nil)
    for (const v of ['SpeedBlock', 'SpeedNumber']) expect(view(v)).toContain('Text(Format.speed(state.speed))');
    expect(src).not.toMatch(/state\.speed \?\?/);
    // nil stays nil on the way in: the bridge record, the display notification, drive-sense's post
    const c = code(IOS_DIR, 'LiveDriveController.swift');
    expect(c).toMatch(/guard let n = info\[key\] as\? NSNumber else \{ return nil \}/);
    expect(c).toMatch(/speed: number\("speed"\),/);
    expect(code(IOS_DIR, 'LiveDriveModule.swift')).toMatch(/@Field var speed: Double\?\n[\s\S]*speed: speed,/);
    const bridge = code(path.join(ROOT, 'modules', 'drive-sense', 'ios'), 'DriveSenseModule.swift');
    expect(bridge).toMatch(/@Field var speed: Double\?/);
    expect(bridge).toMatch(/if let v = s\.speed \{ info\["speed"\] = v \}/);
  });

  it("the speed takes the driving screen's tint over the limit (white otherwise) and never animates", () => {
    const src = widget();
    for (const v of ['SpeedBlock', 'SpeedNumber']) expect(view(v)).toContain('.foregroundColor(Color(hex: state.speedTint) ?? .white)');
    expect(src).not.toMatch(/withAnimation|repeatForever|\.animation\(|scaleEffect|opacity\(pulse/);
    expect(src).toMatch(/return "Speed \\\(speed\(v\)\) \\\(words\)" \+ \(speeding \? ", over the limit" : ""\)/);
    expect(src).toMatch(/guard v != nil else \{ return "Speed unknown" \}/);
    expect(src).toMatch(/let words = unit == "km\/h" \? "kilometers per hour" : "miles per hour"/);
    expect(src).toMatch(/v == nil \? "Speed limit unknown" : "Speed limit \\\(speed\(v\)\)"/);
  });

  it('the hint is the driving screen\'s "Not driving?", 13 pt semibold white at 0.7, only while available', () => {
    const src = widget();
    const literal = /static let notDriving = "([^"]+)"/.exec(src)?.[1];
    const hud = (hudCopy as Record<string, unknown>).notDriving;
    expect(literal).toBe(typeof hud === 'string' ? hud : 'Not driving?');
    const hint = view('NotDrivingHint');
    expect(hint).toMatch(/if state\.notDrivingAvailable \{\s*Text\(Copy\.notDriving\)\s*\.font\(\.system\(size: 13, weight: \.semibold, design: \.rounded\)\)\s*\.foregroundColor\(Palette\.dim\)/);
    expect(src).toMatch(/static let dim = Color\.white\.opacity\(0\.7\)/);
    expect(src.match(/Text\(Copy\.notDriving\)/g)).toHaveLength(1);
  });

  it('the weather line: its symbol and its words, 13 pt semibold white at 0.9, only with an alert; every DangerKind has its symbol', () => {
    const line = view('WeatherLine');
    expect(line).toMatch(/if let kind = state\.weatherKind, let text = state\.weatherText \{/);
    expect(line).toMatch(/Image\(systemName: WeatherSymbol\.name\(kind\)\)/);
    expect(line).toMatch(/\.font\(\.system\(size: 13, weight: \.semibold, design: \.rounded\)\)\s*\.foregroundColor\(Palette\.weather\)/);
    expect(line).toMatch(/\.accessibilityLabel\(text\)/);
    expect(widget()).toMatch(/static let weather = Color\.white\.opacity\(0\.9\)/);
    const symbols = code(WIDGET_DIR, 'WeatherSymbol.swift');
    const cases = new Map([...symbols.matchAll(/case "([a-z_]+)": return "([a-z.]+)"/g)].map((m) => [m[1]!, m[2]!] as const));
    for (const kind of DANGER_ORDER) expect({ kind, mapped: cases.has(kind) }).toEqual({ kind, mapped: true });
    expect([...cases.keys()].sort()).toEqual([...DANGER_ORDER].sort());
    expect(symbols).toMatch(/default: return "exclamationmark\.triangle"/);
    expect(Object.fromEntries(cases)).toMatchObject({ blizzard: 'wind.snow', heavy_rain: 'cloud.heavyrain', thunderstorm: 'cloud.bolt.rain', low_visibility: 'eye.slash', rain_at_night: 'cloud.moon.rain' });
  });

  it('a stale activity (no update for 2 min) shows nothing live: no speed, no tint, no hint, no weather', () => {
    const src = widget();
    expect(src).toContain('context.isStale');
    const stale = /func displayState\(_ context: ActivityViewContext<LiveDriveAttributes>\)[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    for (const line of ['s.speed = nil', 's.speedTint = nil', 's.speeding = false', 's.notDrivingAvailable = false', 's.weatherKind = nil', 's.weatherText = nil']) expect(stale).toContain(line);
    expect(src.replace(stale, '')).not.toMatch(/context\.state/);
  });

  it("wears the app's sky: the lock screen's gradient, its tint, the island's keyline; navy and gold without it", () => {
    const src = widget();
    // "#RRGGBB" only; anything else (or nil) is no colour
    expect(src).toMatch(/init\?\(hex: String\?\) \{\s*guard let hex = hex, hex\.count == 7, hex\.hasPrefix\("#"\) else \{ return nil \}/);
    expect(src).toMatch(/allSatisfy\(\{ \$0\.isHexDigit \}\), let n = UInt32\(digits, radix: 16\) else \{ return nil \}/);
    expect(src).toMatch(
      /if let top = Color\(hex: state\.skyTop\), let mid = Color\(hex: state\.skyMid\), let low = Color\(hex: state\.skyLow\) \{\s*LinearGradient\(colors: \[top, mid, low\], startPoint: \.top, endPoint: \.bottom\)\s*\} else \{\s*Palette\.navy\s*\}/
    );
    expect(src).toMatch(/\.background \{ ground \}/);
    expect(src).toContain('.activityBackgroundTint(Color(hex: state.skyMid) ?? Palette.navy)');
    expect(src).toContain('.keylineTint(Color(hex: state.accent) ?? Palette.gold)');
    expect(src).toMatch(/red: 0 \/ 255, green: 29 \/ 255, blue: 61 \/ 255/);
    expect(src).toMatch(/red: 255 \/ 255, green: 195 \/ 255, blue: 0 \/ 255/);
    expect(src).toMatch(/signRed = Color\(red: 215 \/ 255, green: 38 \/ 255, blue: 61 \/ 255\)/);
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
