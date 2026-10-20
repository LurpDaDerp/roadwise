/** @jest-environment node */
// The Swift half of live-drive (the Expo module and the widget extension target) cannot be compiled
// here, so this suite pins what can be checked as text: the bridge surface, the one rule that the
// ActivityAttributes type is byte-identical in the app and the widget (ActivityKit matches them by
// type), the iOS 16.2 gate, the palette, the sky and copy of the widget, and the config plugin wiring.
import { LIVE_DRIVE_METHODS } from '../src/types';

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

describe('live-drive: the Expo module (iOS)', () => {
  const module = () => code(IOS_DIR, 'LiveDriveModule.swift');

  it('is registered for Apple only, under the name the JS wrapper requires', () => {
    const config = JSON.parse(read(MODULE_DIR, 'expo-module.config.json'));
    expect(config.platforms).toEqual(['apple']);
    expect(config.apple.modules).toEqual(['LiveDriveModule']);
    expect(module()).toMatch(/Name\("LiveDrive"\)/);
  });

  it('declares one AsyncFunction per LIVE_DRIVE_METHODS entry and no others', () => {
    const declared = [...module().matchAll(/AsyncFunction\("([^"]+)"\)/g)].map((x) => x[1]);
    expect([...declared].sort()).toEqual([...LIVE_DRIVE_METHODS].sort());
  });

  it('gates every ActivityKit use on iOS 16.2 and ends stale activities at module creation', () => {
    const src = module();
    expect(src.match(/#available\(iOS 16\.2, \*\)/g)?.length).toBeGreaterThanOrEqual(5);
    expect(src).toMatch(/OnCreate \{[\s\S]*?LiveDriveController\.shared\.endAll\(\)/);
    const ctrl = code(IOS_DIR, 'LiveDriveController.swift');
    expect(ctrl).toMatch(/@available\(iOS 16\.2, \*\)\s*final class LiveDriveController/);
    expect(ctrl).toMatch(/Activity<LiveDriveAttributes>\.activities/);
    expect(ctrl).toMatch(/dismissalPolicy: \.immediate/);
  });

  it('every content carries a stale date, and the widget blanks a stale state (review I1)', () => {
    const ctrl = code(IOS_DIR, 'LiveDriveController.swift');
    expect(ctrl).toMatch(/STALE_AFTER_S: TimeInterval = 120/);
    expect(ctrl).toContain('staleDate: Date().addingTimeInterval(STALE_AFTER_S)');
    expect(ctrl).not.toMatch(/staleDate: nil/);
    expect(ctrl.match(/Self\.content\(state\)/g)).toHaveLength(2);
    const widget = code(WIDGET_DIR, 'LiveDriveWidgetBundle.swift');
    expect(widget).toContain('context.isStale');
    expect(widget).toMatch(/func displayState\(_ context: ActivityViewContext<LiveDriveAttributes>\)/);
    expect(widget).not.toMatch(/context\.state\.(speed|limit|points|stopped|unit)/);
  });

  it('an activity is started only by `start`, which ends any running one first; update and end are no-ops without one', () => {
    const ctrl = code(IOS_DIR, 'LiveDriveController.swift');
    expect(ctrl.match(/Activity\.request\(/g)).toHaveLength(1);
    expect(ctrl).toMatch(/func start\([\s\S]{0,120}endAll\(\)/);
    expect(ctrl).toMatch(/func update\([\s\S]{0,80}guard let a = activity else \{ return \}/);
    expect(ctrl).toMatch(/func end\(\) \{\s*guard let a = activity else \{ return \}/);
  });

  it('listens for drive-sense setDriveDisplay (roadwise.driveDisplay) and maps it to the content state', () => {
    const ctrl = code(IOS_DIR, 'LiveDriveController.swift');
    expect(ctrl).toMatch(/Notification\.Name\("roadwise\.driveDisplay"\)/);
    const bridge = code(path.join(ROOT, 'modules', 'drive-sense', 'ios'), 'DriveSenseModule.swift');
    expect(bridge).toMatch(/Notification\.Name\("roadwise\.driveDisplay"\)/);
    expect(ctrl).toMatch(/if info\["ended"\] as\? Bool == true \{\s*self\.end\(\)/);
    expect(bridge).toMatch(/static func postEnded\(\)[\s\S]{0,160}"ended": true/);
    for (const k of ['speed', 'limit', 'unit', 'points', 'pointsDelta', 'stopped', 'skyTop', 'skyMid', 'skyLow', 'accent']) expect(ctrl).toContain(`"${k}"`);
    // the sky arrives as strings
    for (const k of ['skyTop', 'skyMid', 'skyLow', 'accent']) expect(ctrl).toContain(`${k}: text("${k}")`);
  });

  it('the bridge record carries the sky into the content state', () => {
    const src = module();
    const record = /struct LiveDriveStateRecord: Record \{([\s\S]*?)\n {2}@available/.exec(src)?.[1] ?? '';
    const fields = [...record.matchAll(/@Field var (\w+): ([\w?]+)/g)].map((m) => `${m[1]}: ${m[2]}`);
    expect(fields).toEqual([
      'speed: Double?',
      'limit: Double?',
      'unit: String',
      'points: Double?',
      'pointsDelta: Double?',
      'stopped: Bool',
      'skyTop: String?',
      'skyMid: String?',
      'skyLow: String?',
      'accent: String?',
    ]);
    for (const k of ['skyTop', 'skyMid', 'skyLow', 'accent']) expect(src).toContain(`${k}: ${k}`);
  });

  it('the podspec links ActivityKit weakly (iOS 15.1 minimum stays)', () => {
    const podspec = read(IOS_DIR, 'LiveDrive.podspec');
    expect(podspec).toContain("s.weak_frameworks = 'ActivityKit'");
    expect(podspec).toContain("s.platforms      = { :ios => '15.1' }");
  });
});

describe('live-drive: the widget extension target', () => {
  it('LiveDriveAttributes.swift is byte-identical in the module and the widget', () => {
    expect(read(WIDGET_DIR, 'LiveDriveAttributes.swift')).toBe(read(IOS_DIR, 'LiveDriveAttributes.swift'));
  });

  it('the attributes mirror LiveDriveState field for field', () => {
    const src = code(IOS_DIR, 'LiveDriveAttributes.swift');
    expect(src).toMatch(/struct LiveDriveAttributes: ActivityAttributes/);
    const state = /struct ContentState: Codable, Hashable \{([\s\S]*?)\n {2}\}/.exec(src)?.[1] ?? '';
    const fields = [...state.matchAll(/var (\w+): ([\w?]+)/g)].map((m) => `${m[1]}: ${m[2]}`);
    expect(fields).toEqual([
      'speed: Double?',
      'limit: Double?',
      'unit: String',
      'points: Double?',
      'pointsDelta: Double?',
      'stopped: Bool',
      'skyTop: String?',
      'skyMid: String?',
      'skyLow: String?',
      'accent: String?',
    ]);
  });

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
    for (const region of ['.leading', '.trailing', '.bottom']) expect(src).toContain(`DynamicIslandExpandedRegion(${region})`);
    expect(src).toMatch(/compactLeading: \{/);
    expect(src).toMatch(/compactTrailing: \{/);
    expect(src).toMatch(/minimal: \{/);
    // points only when present (lock screen) and only when stopped (expanded island)
    expect(src).toMatch(/if let p = state\.points \{/);
    expect(src).toMatch(/if state\.stopped, state\.points != nil \{/);
    // "—" for an unknown speed or limit
    expect(src).toMatch(/guard let v = v, v\.isFinite else \{ return "—" \}/);
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
    // the limit sign's ring is the driving screen's red; the points line white, total only
    expect(src).toMatch(/signRed = Color\(red: 215 \/ 255, green: 38 \/ 255, blue: 61 \/ 255\)/);
    expect(src).toContain('Circle().strokeBorder(Palette.signRed,');
    expect(src).toMatch(/static let points = Color\.white\.opacity\(0\.85\)/);
    expect(src).toContain('Text(Format.points(p))');
    expect(src).toContain('.foregroundColor(Palette.points)');
    expect(src).toMatch(/static func points\(_ points: Double\) -> String \{/);
    expect(src).toContain('return "\\(total) pts"');
    expect(src).not.toMatch(/pointsDelta(?! = nil)/);
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
