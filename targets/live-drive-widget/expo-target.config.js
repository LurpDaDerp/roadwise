// The Live Activity / Dynamic Island widget extension (plan §6), generated into the Xcode project
// by @bacons/apple-targets on `npx expo prebuild`. Swift sources in this folder are the target's;
// `LiveDriveAttributes.swift` is a byte-identical copy of modules/live-drive/ios/LiveDriveAttributes.swift.
/** @type {import('@bacons/apple-targets/app.plugin').Config} */
module.exports = {
  type: 'widget',
  name: 'LiveDriveWidget',
  displayName: 'RoadWise Drive',
  bundleIdentifier: '.livedrive',
  // ActivityKit's `Activity.request(attributes:content:pushType:)` and `end(_:dismissalPolicy:)`.
  deploymentTarget: '16.2',
  frameworks: ['SwiftUI', 'WidgetKit', 'ActivityKit'],
  colors: {
    // The repo's navy/gold palette (src/ui/tokens.ts).
    $widgetBackground: '#001D3D',
    $accent: '#FFC300',
  },
};
