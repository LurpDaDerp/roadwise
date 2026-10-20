// The Live Activity's attributes — shared by the app (modules/live-drive/ios) and the widget
// extension (targets/live-drive-widget). ActivityKit matches an activity to its widget by this
// type, so the two copies must stay byte-identical (modules/live-drive/__tests__ compares them).
import ActivityKit
import Foundation

@available(iOS 16.2, *)
struct LiveDriveAttributes: ActivityAttributes {
  /// Mirrors `LiveDriveState` in modules/live-drive/src/types.ts, field for field.
  struct ContentState: Codable, Hashable {
    /// current speed in `unit`; nil shows "—"
    var speed: Double?
    /// posted limit in `unit`; nil shows "—"
    var limit: Double?
    /// "mph" or "km/h"
    var unit: String
    /// shown only when present (the host sends it only while stopped)
    var points: Double?
    /// change since the last stop; not shown (the app sends nil)
    var pointsDelta: Double?
    /// at or under 5 mph
    var stopped: Bool
    /// the app's sky, "#RRGGBB" top to bottom: the lock screen's gradient; nil: navy
    var skyTop: String?
    var skyMid: String?
    var skyLow: String?
    /// the sky accent, "#RRGGBB": the island's keyline; nil: gold
    var accent: String?
  }

  /// When the drive started; fixed for the activity's life.
  var startedAt: Date
}
