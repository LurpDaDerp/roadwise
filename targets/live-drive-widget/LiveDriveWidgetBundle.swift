// The Live Activity / Dynamic Island for a drive in progress (plan §3.10). The lock screen: the
// speed, coloured as the driving screen colours it when over the limit (it never pulses), the speed
// limit in the driving screen's sign style (the US SPEED LIMIT plate in mph, the round red-ringed
// sign in km/h), the driving screen's dangerous-weather line when it has one, and "Not driving?"
// while that option is available. The island: expanded = speed, sign, and the weather line and
// the hint below; compact = speed | mini sign; minimal = speed. The lock screen wears the app's sky
// (navy until the app sends it), the island's keyline the sky accent (gold without one). A tap opens
// the driving screen; nothing else is interactive.
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
  static let weather = Color.white.opacity(0.9)
}

/// The words on the activity (the hint is the driving screen's own: `hudCopy.notDriving`).
enum Copy {
  static let notDriving = "Not driving?"
  static let tapURL = URL(string: "roadwise://drive")
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
  /// "34", or "-" when unknown.
  static func speed(_ v: Double?) -> String {
    guard let v = v, v.isFinite else { return "-" }
    return String(Int(v.rounded()))
  }

  static func speedLabel(_ v: Double?, unit: String, speeding: Bool) -> String {
    guard v != nil else { return "Speed unknown" }
    let words = unit == "km/h" ? "kilometers per hour" : "miles per hour"
    return "Speed \(speed(v)) \(words)" + (speeding ? ", over the limit" : "")
  }

  static func limitLabel(_ v: Double?) -> String {
    v == nil ? "Speed limit unknown" : "Speed limit \(speed(v))"
  }
}

/// The posted limit in the driving screen's sign style for the unit: the US R2-1 plate for mph
/// (white, a black inner border, "SPEED" / "LIMIT" when 30 pt tall or more, the number), the round
/// sign for km/h (white disc, red ring, the number). "-" when unknown.
struct LimitSign: View {
  let limit: Double?
  let unit: String
  var height: CGFloat = 44

  var body: some View {
    Group {
      if unit == "km/h" { roundSign } else { usPlate }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Format.limitLabel(limit))
  }

  private var usPlate: some View {
    let w = height * 0.8
    return ZStack {
      RoundedRectangle(cornerRadius: w * 0.06).fill(Color.white)
      RoundedRectangle(cornerRadius: max(0, w * 0.06 - 2))
        .strokeBorder(Color.black, lineWidth: max(1.5, w * 0.025))
        .padding(2)
      VStack(spacing: 0) {
        if height >= 30 {
          Text("SPEED").font(.system(size: height * 0.167, weight: .bold))
          Text("LIMIT").font(.system(size: height * 0.167, weight: .bold))
        }
        Text(Format.speed(limit))
          .font(.system(size: height * 0.46, weight: .heavy, design: .rounded))
          .monospacedDigit()
      }
      .foregroundColor(.black)
      .minimumScaleFactor(0.5)
      .lineLimit(1)
    }
    .frame(width: w, height: height)
  }

  private var roundSign: some View {
    ZStack {
      Circle().fill(Color.white)
      Circle().strokeBorder(Palette.signRed, lineWidth: max(2, height * 0.09))
      Text(Format.speed(limit))
        .font(.system(size: height * 0.42, weight: .bold, design: .rounded))
        .monospacedDigit()
        .foregroundColor(.black)
        .minimumScaleFactor(0.6)
        .lineLimit(1)
    }
    .frame(width: height, height: height)
  }
}

/// The speed, large, in the driving screen's tint over the limit (white otherwise), the unit under it.
struct SpeedBlock: View {
  let state: LiveDriveAttributes.ContentState
  var size: CGFloat = 48

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text(Format.speed(state.speed))
        .font(.system(size: size, weight: .heavy, design: .rounded))
        .monospacedDigit()
        .foregroundColor(Color(hex: state.speedTint) ?? .white)
        .lineLimit(1)
      Text(state.unit)
        .font(.system(size: max(11, size * 0.28), weight: .semibold, design: .rounded))
        .foregroundColor(Palette.dim)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(Format.speedLabel(state.speed, unit: state.unit, speeding: state.speeding))
  }
}

/// The speed alone (the compact and minimal island), tinted.
struct SpeedNumber: View {
  let state: LiveDriveAttributes.ContentState
  let size: CGFloat

  var body: some View {
    Text(Format.speed(state.speed))
      .font(.system(size: size, weight: .bold, design: .rounded))
      .monospacedDigit()
      .foregroundColor(Color(hex: state.speedTint) ?? .white)
      .accessibilityLabel(Format.speedLabel(state.speed, unit: state.unit, speeding: state.speeding))
  }
}

/// The dangerous-weather line: its symbol and its words, when the driving screen shows an alert.
struct WeatherLine: View {
  let state: LiveDriveAttributes.ContentState

  var body: some View {
    if let kind = state.weatherKind, let text = state.weatherText {
      HStack(spacing: 6) {
        Image(systemName: WeatherSymbol.name(kind))
        Text(text).lineLimit(1)
      }
      .font(.system(size: 13, weight: .semibold, design: .rounded))
      .foregroundColor(Palette.weather)
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(text)
    }
  }
}

/// "Not driving?" while the option is available.
struct NotDrivingHint: View {
  let state: LiveDriveAttributes.ContentState

  var body: some View {
    if state.notDrivingAvailable {
      Text(Copy.notDriving)
        .font(.system(size: 13, weight: .semibold, design: .rounded))
        .foregroundColor(Palette.dim)
        .lineLimit(1)
    }
  }
}

/// The lock-screen banner (and the StandBy surfaces WidgetKit derives from it).
struct LockScreenView: View {
  let state: LiveDriveAttributes.ContentState

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .center, spacing: 16) {
        SpeedBlock(state: state, size: 52)
        Spacer(minLength: 8)
        LimitSign(limit: state.limit, unit: state.unit, height: 56)
      }
      WeatherLine(state: state)
      if state.notDrivingAvailable {
        HStack {
          Spacer(minLength: 0)
          NotDrivingHint(state: state)
        }
      }
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

/// Past `staleDate` (no update for 2 min: the app is gone) nothing here is live: speed unknown, no
/// tint, no hint, no weather.
func displayState(_ context: ActivityViewContext<LiveDriveAttributes>) -> LiveDriveAttributes.ContentState {
  guard context.isStale else { return context.state }
  var s = context.state
  s.speed = nil
  s.speedTint = nil
  s.speeding = false
  s.notDrivingAvailable = false
  s.weatherKind = nil
  s.weatherText = nil
  return s
}

struct LiveDriveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LiveDriveAttributes.self) { context in
      let state = displayState(context)
      return LockScreenView(state: state)
        .activityBackgroundTint(Color(hex: state.skyMid) ?? Palette.navy)
        .activitySystemActionForegroundColor(.white)
        .widgetURL(Copy.tapURL)
    } dynamicIsland: { context in
      let state = displayState(context)
      return DynamicIsland {
        DynamicIslandExpandedRegion(.leading) {
          SpeedBlock(state: state, size: 40)
            .padding(.leading, 6)
        }
        DynamicIslandExpandedRegion(.trailing) {
          LimitSign(limit: state.limit, unit: state.unit, height: 44)
            .padding(.trailing, 6)
        }
        DynamicIslandExpandedRegion(.bottom) {
          HStack(spacing: 8) {
            WeatherLine(state: state)
            Spacer(minLength: 0)
            NotDrivingHint(state: state)
          }
          .padding(.horizontal, 6)
        }
      } compactLeading: {
        SpeedNumber(state: state, size: 15)
          .padding(.leading, 2)
      } compactTrailing: {
        LimitSign(limit: state.limit, unit: state.unit, height: 20)
      } minimal: {
        SpeedNumber(state: state, size: 13)
      }
      .keylineTint(Color(hex: state.accent) ?? Palette.gold)
      .widgetURL(Copy.tapURL)
    }
  }
}
