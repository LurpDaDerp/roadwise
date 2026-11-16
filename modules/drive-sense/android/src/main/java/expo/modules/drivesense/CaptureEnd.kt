package expo.modules.drivesense

/**
 * What JS says about a drive's end at `stopCapture` (README §2): when its driving ended
 * ([drivingEndedAt]; null when the drive was not kept), whether the car was still at driving speed
 * as it ended ([drivingAtEnd]), and whether a JS automatic end rule ended it ([automatic]: the
 * detector's linger watches on after such an end, as iOS's does; until Android's detector exists
 * nothing reads it, and an automatic end is an "at" end with its cut).
 */
data class CaptureEnd(val drivingEndedAt: Long?, val drivingAtEnd: Boolean, val automatic: Boolean = false) {
  companion object {
    /**
     * `stopCapture`'s arguments: [kind] "dropped" (not kept), "at" (driving ended at [endedAt]),
     * "auto" (the same, ended by a JS automatic rule), or anything else, "now" included: null,
     * nothing known (the end is now, as the watchdog's is).
     */
    fun of(kind: String, endedAt: Double, drivingAtEnd: Boolean): CaptureEnd? = when (kind) {
      "dropped" -> CaptureEnd(null, drivingAtEnd)
      "at", "auto" -> if (endedAt.isFinite() && endedAt >= 0.0) CaptureEnd(endedAt.toLong(), drivingAtEnd, automatic = kind == "auto") else null
      else -> null
    }
  }
}
