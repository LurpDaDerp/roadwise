// What JS says about a drive's end at `stopCapture` (README §2): when its driving ended
// (`drivingEndedAt`, the cut the journal's `end` line records; nil when the drive was not kept, then
// the end is now), whether the car was still at driving speed as it ended (`drivingAtEnd`), and
// whether a JS automatic end rule ended it (`automatic`, iOS: the detector's linger watches on
// after it). The Kotlin `CaptureEnd` is the same less `automatic` (JS never sends "auto" there).
struct CaptureEnd: Equatable {
  let drivingEndedAt: Double?
  let drivingAtEnd: Bool
  var automatic: Bool = false

  /// `stopCapture`'s arguments: `kind` "dropped" (not kept), "at" (driving ended at `endedAt`),
  /// "auto" (the same, ended by a JS automatic rule), or anything else, "now" included: nil,
  /// nothing known (the end is now).
  static func of(_ kind: String, _ endedAt: Double, _ drivingAtEnd: Bool) -> CaptureEnd? {
    switch kind {
    case "dropped":
      return CaptureEnd(drivingEndedAt: nil, drivingAtEnd: drivingAtEnd)
    case "at", "auto":
      guard endedAt.isFinite && endedAt >= 0 else { return nil }
      return CaptureEnd(drivingEndedAt: endedAt, drivingAtEnd: drivingAtEnd, automatic: kind == "auto")
    default:
      return nil
    }
  }
}
