// The Live Activity / Dynamic Island for a drive in progress (spec "Driving screen · Background";
// plan §6). The speed and the speed limit, nothing else. Lock screen: big speed, a round
// speed-limit sign. Dynamic Island: expanded = speed + limit; compact = speed | limit;
// minimal = speed. The lock screen wears the app's sky (the driving screen's deepened sky,
// top to bottom, as the app sends it with the state; navy until it does), the island's keyline the
// sky accent (gold without one); white numerals, the limit sign's ring the driving screen's red.
// Nothing here is interactive: the activity is started and ended by the app alone.
import ActivityKit
import SwiftUI
import WidgetKit

@main
struct LiveDriveWidgetBundle: WidgetBundle {
  var body: some Widget {
    LiveDriveActivityWidget()
  }
}

enum Palette {
  static let navy = Color(red: 0 / 255, green: 29 / 255, blue: 61 / 255) // #001D3D
  static let gold = Color(red: 255 / 255, green: 195 / 255, blue: 0 / 255) // #FFC300
  static let signRed = Color(red: 215 / 255, green: 38 / 255, blue: 61 / 255) // #D7263D
  static let dim = Color.white.opacity(0.7)
}

extension Color {
  /// "#RRGGBB" as a colour; nil for nil or anything else.
  init?(hex: String?) {
    guard let hex = hex, hex.count == 7, hex.hasPrefix("#") else { return nil }
    let digits = hex.dropFirst()
    guard digits.allSatisfy({ $0.isHexDigit }), let n = UInt32(digits, radix: 16) else { return nil }
    self.init(
      red: Double((n >> 16) & 0xFF) / 255,
      green: Double((n >> 8) & 0xFF) / 255,
      blue: Double(n & 0xFF) / 255
    )
  }
}

enum Format {
  /// "34", or "—" when unknown.
  static func speed(_ v: Double?) -> String {
    guard let v = v, v.isFinite else { return "—" }
    return String(Int(v.rounded()))
  }
}

/// The posted limit as a round sign: white disc, red ring, black numeral ("—" when unknown).
struct LimitSign: View {
  let limit: Double?
  var size: CGFloat = 44

  var body: some View {
    ZStack {
      Circle().fill(Color.white)
      Circle().strokeBorder(Palette.signRed, lineWidth: max(2, size * 0.09))
      Text(Format.speed(limit))
        .font(.system(size: size * 0.42, weight: .bold, design: .rounded))
        .monospacedDigit()
        .foregroundColor(.black)
        .minimumScaleFactor(0.6)
        .lineLimit(1)
    }
    .frame(width: size, height: size)
    .accessibilityLabel("Speed limit \(Format.speed(limit))")
  }
}

/// Speed, large, with the unit under it.
struct SpeedBlock: View {
  let speed: Double?
  let unit: String
  var size: CGFloat = 48

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(Format.speed(speed))
        .font(.system(size: size, weight: .heavy, design: .rounded))
        .monospacedDigit()
        .foregroundColor(.white)
        .lineLimit(1)
      Text(unit)
        .font(.system(size: max(11, size * 0.28), weight: .semibold, design: .rounded))
        .foregroundColor(Palette.dim)
    }
  }
}

/// The lock-screen banner (and the StandBy / CarPlay-adjacent surfaces WidgetKit derives from it).
struct LockScreenView: View {
  let state: LiveDriveAttributes.ContentState

  var body: some View {
    HStack(alignment: .center, spacing: 16) {
      SpeedBlock(speed: state.speed, unit: state.unit, size: 52)
      Spacer(minLength: 8)
      LimitSign(limit: state.limit, size: 56)
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 14)
    .background { ground }
  }

  /// The app's sky top to bottom when it sent all three stops; navy otherwise.
  @ViewBuilder
  var ground: some View {
    if let top = Color(hex: state.skyTop), let mid = Color(hex: state.skyMid), let low = Color(hex: state.skyLow) {
      LinearGradient(colors: [top, mid, low], startPoint: .top, endPoint: .bottom)
    } else {
      Palette.navy
    }
  }
}

/// Past `staleDate` (no update for 2 min: the app is gone) nothing here is live: speed unknown.
func displayState(_ context: ActivityViewContext<LiveDriveAttributes>) -> LiveDriveAttributes.ContentState {
  guard context.isStale else { return context.state }
  var s = context.state
  s.speed = nil
  s.stopped = false
  return s
}

struct LiveDriveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LiveDriveAttributes.self) { context in
      let state = displayState(context)
      return LockScreenView(state: state)
        .activityBackgroundTint(Color(hex: state.skyMid) ?? Palette.navy)
        .activitySystemActionForegroundColor(.white)
    } dynamicIsland: { context in
      let state = displayState(context)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          SpeedBlock(speed: state.speed, unit: state.unit, size: 40)
            .padding(.leading, 6)
        }
        DynamicIslandExpandedRegion(.trailing) {
          LimitSign(limit: state.limit, size: 44)
            .padding(.trailing, 6)
        }
      } compactLeading: {
        Text(Format.speed(state.speed))
          .font(.system(size: 15, weight: .bold, design: .rounded))
          .monospacedDigit()
          .foregroundColor(.white)
          .padding(.leading, 2)
      } compactTrailing: {
        LimitSign(limit: state.limit, size: 20)
      } minimal: {
        Text(Format.speed(state.speed))
          .font(.system(size: 13, weight: .bold, design: .rounded))
          .monospacedDigit()
          .foregroundColor(.white)
      }
      .keylineTint(Color(hex: state.accent) ?? Palette.gold)
    }
  }
}
