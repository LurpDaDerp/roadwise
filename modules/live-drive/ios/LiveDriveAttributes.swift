// The Live Activity's attributes — shared by the app (modules/live-drive/ios) and the widget
// extension (targets/live-drive-widget). ActivityKit matches an activity to its widget by this
// type, so the two copies must stay byte-identical (modules/live-drive/__tests__ compares them). A
// push-to-start payload carries both halves as JSON under these names.
import ActivityKit
import Foundation

@available(iOS 16.2, *)
struct LiveDriveAttributes: ActivityAttributes {
  /// Mirrors `LiveDriveState` in modules/live-drive/src/types.ts, field for field.
  struct ContentState: Codable, Hashable {
    /// current speed in `unit`; nil shows "-"
    var speed: Double?
    /// posted limit in `unit`; nil shows "-"
    var limit: Double?
    /// "mph" draws the US SPEED LIMIT plate, "km/h" the round red-ringed sign
    var unit: String
    /// the driving screen's numeral colour at its speeding tint, "#RRGGBB"; nil: white
    var speedTint: String?
    /// over the limit now (VoiceOver only)
    var speeding: Bool
    /// the "Not driving?" hint shows
    var notDrivingAvailable: Bool
    /// the driving screen's dangerous-weather alert: its kind (a DangerKind id) and its line; nil: none
    var weatherKind: String?
    var weatherText: String?
    /// the app's sky, "#RRGGBB" top to bottom: the lock screen's gradient; nil: navy
    var skyTop: String?
    var skyMid: String?
    var skyLow: String?
    /// the sky accent, "#RRGGBB": the island's keyline; nil: gold
    var accent: String?
  }

  /// When the drive started, epoch ms; fixed for the activity's life.
  var startedAt: Double
}
