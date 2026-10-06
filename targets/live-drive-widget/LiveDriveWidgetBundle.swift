// The Live Activity / Dynamic Island for a drive in progress (spec "Driving screen · Background";
// plan §6). Lock screen: big speed, a round speed-limit sign, a points line only when points are
// present. Dynamic Island: expanded = speed + limit (+ points when stopped); compact = speed |
// limit; minimal = speed. Navy/gold palette, white numerals. Nothing here is interactive: the
// activity is started and ended by the app alone.
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
  static let dim = Color.white.opacity(0.7)
}

enum Format {
  /// "34", or "—" when unknown.
  static func speed(_ v: Double?) -> String {
    guard let v = v, v.isFinite else { return "—" }
    return String(Int(v.rounded()))
  }

  /// "1,240 pts", with " (+18)" / " (−18)" when the delta is present and non-zero.
  static func points(_ points: Double, delta: Double?) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.maximumFractionDigits = 0
    let total = f.string(from: NSNumber(value: points.rounded())) ?? String(Int(points.rounded()))
    var text = "\(total) pts"
    if let d = delta, d.isFinite, d.rounded() != 0 {
      let magnitude = f.string(from: NSNumber(value: abs(d).rounded())) ?? String(Int(abs(d).rounded()))
      text += d > 0 ? " (+\(magnitude))" : " (−\(magnitude))"
    }
    return text
  }
}

/// The posted limit as a round sign: white disc, gold ring, black numeral ("—" when unknown).
struct LimitSign: View {
  let limit: Double?
  var size: CGFloat = 44

  var body: some View {
    ZStack {
      Circle().fill(Color.white)
      Circle().strokeBorder(Palette.gold, lineWidth: max(2, size * 0.09))
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

struct PointsLine: View {
  let state: LiveDriveAttributes.ContentState

  var body: some View {
    if let p = state.points {
      Text(Format.points(p, delta: state.pointsDelta))
        .font(.system(size: 15, weight: .semibold, design: .rounded))
        .monospacedDigit()
        .foregroundColor(Palette.gold)
        .lineLimit(1)
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
      VStack(alignment: .trailing, spacing: 6) {
        LimitSign(limit: state.limit, size: 52)
        PointsLine(state: state)
      }
    }
    .padding(.horizontal, 20)
    .padding(.vertical, 14)
    .background(Palette.navy)
  }
}

/// Past `staleDate` (no update for 2 min: the app is gone) nothing here is live: speed unknown, no points.
func displayState(_ context: ActivityViewContext<LiveDriveAttributes>) -> LiveDriveAttributes.ContentState {
  guard context.isStale else { return context.state }
  var s = context.state
  s.speed = nil
  s.points = nil
  s.pointsDelta = nil
  s.stopped = false
  return s
}

struct LiveDriveActivityWidget: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: LiveDriveAttributes.self) { context in
      LockScreenView(state: displayState(context))
        .activityBackgroundTint(Palette.navy)
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
        DynamicIslandExpandedRegion(.bottom) {
          if state.stopped, state.points != nil {
            PointsLine(state: state)
              .frame(maxWidth: .infinity, alignment: .center)
              .padding(.bottom, 4)
          }
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
      .keylineTint(Palette.gold)
    }
  }
}
