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
    /// change since the last stop; shown beside `points` when present and non-zero
    var pointsDelta: Double?
    /// at or under 5 mph
    var stopped: Bool
  }

  /// When the drive started; fixed for the activity's life.
  var startedAt: Date
}
