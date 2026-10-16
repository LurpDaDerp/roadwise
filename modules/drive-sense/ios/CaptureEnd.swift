// What JS says about a drive's end at `stopCapture` (README §2), for the forgot-to-start reminder:
// when its driving ended (`drivingEndedAt`; nil when the drive was not kept) and whether the car was
// still at driving speed as it ended (`drivingAtEnd`). The Kotlin `CaptureEnd` is the same.
struct CaptureEnd: Equatable {
  let drivingEndedAt: Double?
  let drivingAtEnd: Bool

  /// `stopCapture`'s arguments: `kind` "dropped" (not kept), "at" (driving ended at `endedAt`), or
  /// anything else, "now" included: nil, nothing known (the end is now, as the watchdog's is).
  static func of(_ kind: String, _ endedAt: Double, _ drivingAtEnd: Bool) -> CaptureEnd? {
    switch kind {
    case "dropped":
      return CaptureEnd(drivingEndedAt: nil, drivingAtEnd: drivingAtEnd)
    case "at":
      return endedAt.isFinite && endedAt >= 0 ? CaptureEnd(drivingEndedAt: endedAt, drivingAtEnd: drivingAtEnd) : nil
    default:
      return nil
    }
  }
}
