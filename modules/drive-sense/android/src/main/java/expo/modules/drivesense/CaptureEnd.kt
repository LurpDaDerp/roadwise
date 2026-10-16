package expo.modules.drivesense

/**
 * What JS says about a drive's end at `stopCapture` (README §2), for the forgot-to-start reminder:
 * when its driving ended ([drivingEndedAt]; null when the drive was not kept) and whether the car
 * was still at driving speed as it ended ([drivingAtEnd]).
 */
data class CaptureEnd(val drivingEndedAt: Long?, val drivingAtEnd: Boolean) {
  companion object {
    /**
     * `stopCapture`'s arguments: [kind] "dropped" (not kept), "at" (driving ended at [endedAt]), or
     * anything else, "now" included: null, nothing known (the end is now, as the watchdog's is).
     */
    fun of(kind: String, endedAt: Double, drivingAtEnd: Boolean): CaptureEnd? = when (kind) {
      "dropped" -> CaptureEnd(null, drivingAtEnd)
      "at" -> if (endedAt.isFinite() && endedAt >= 0.0) CaptureEnd(endedAt.toLong(), drivingAtEnd) else null
      else -> null
    }
  }
}
