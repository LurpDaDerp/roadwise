package expo.modules.drivesense

/**
 * The words on the drive notification, from a [DriveDisplay] (pure: no Android type, so the JVM
 * tests hold them). They are the Live Activity's (targets/live-drive-widget: `Format`, `Copy`) laid
 * out in a notification's lines:
 * - title: the speed and its unit, "34 mph" ("- mph" until the drive's first fix, and once stale);
 *   the number wears the speeding tint ([speedRange]);
 * - text: "Limit 35" ("Limit -" when unknown; the sign itself is the large icon), then the weather
 *   line (its symbol and title, "🌧️ Heavy rain") while the driving screen shows its weather card,
 *   then "Not driving?" while that option lasts: one line joined by " · " collapsed, one per line
 *   expanded ([bigText]);
 * - the status-bar chip of a Live Update ([chip]): "34 mph", or the number alone when that would
 *   run past [CHIP_MAX] characters ("120" for 120 km/h);
 * - TalkBack ([accessibility], the ticker): VoiceOver's words, "Speed 34 miles per hour, over the
 *   limit. Speed limit 35. Heavy rain. Not driving?".
 * Nothing about scores or problem spots appears on it.
 */
object DriveNotificationText {
  /** No update for this long means the app is gone: the notification then shows [DriveDisplay.stale] (LiveDriveController.STALE_AFTER_S). */
  const val STALE_AFTER_MS = 120_000L

  /** The driving screen's own hint (`hudCopy.notDriving`). */
  const val NOT_DRIVING = "Not driving?"

  /** The most a Live Update's chip text should run to before the system cuts it (Android's guidance: under 7). */
  const val CHIP_MAX = 7

  /** "34", or "-" when unknown (the widget's `Format.speed`; speeds and limits are never negative). */
  fun number(v: Double?): String {
    if (v == null || !v.isFinite()) return "-"
    return Math.round(v).toString()
  }

  /** "34 mph" / "- km/h". */
  fun title(d: DriveDisplay): String = "${number(d.speed)} ${d.unit}"

  /** Where the number sits in [title]: the span the speeding tint colours. */
  fun speedRange(d: DriveDisplay): IntRange = 0 until number(d.speed).length

  /** "Limit 35" / "Limit -". */
  fun limitLine(d: DriveDisplay): String = "Limit ${number(d.limit)}"

  /** "🌧️ Heavy rain" while the driving screen shows its weather card; null otherwise. */
  fun weatherLine(d: DriveDisplay): String? {
    val kind = d.weatherKind ?: return null
    val text = d.weatherText ?: return null
    return "${WeatherSymbol.of(kind)} $text"
  }

  fun lines(d: DriveDisplay): List<String> = listOfNotNull(
    limitLine(d),
    weatherLine(d),
    if (d.notDrivingAvailable) NOT_DRIVING else null
  )

  /** The collapsed line. */
  fun text(d: DriveDisplay): String = lines(d).joinToString(" · ")

  /** The expanded lines, one per line; null when there is only the limit (no expanded style then). */
  fun bigText(d: DriveDisplay): String? = lines(d).takeIf { it.size > 1 }?.joinToString("\n")

  /** The Live Update chip: "34 mph", or the number alone past [CHIP_MAX] characters. */
  fun chip(d: DriveDisplay): String = title(d).takeIf { it.length <= CHIP_MAX } ?: number(d.speed)

  /** VoiceOver's speed label (`Format.speedLabel`). */
  fun speedLabel(d: DriveDisplay): String {
    if (d.speed == null) return "Speed unknown"
    val words = if (d.unit == "km/h") "kilometers per hour" else "miles per hour"
    return "Speed ${number(d.speed)} $words" + if (d.speeding) ", over the limit" else ""
  }

  /** VoiceOver's limit label (`Format.limitLabel`). */
  fun limitLabel(d: DriveDisplay): String = if (d.limit == null) "Speed limit unknown" else "Speed limit ${number(d.limit)}"

  /** What TalkBack reads: the labels, the weather line as its words and the hint. */
  fun accessibility(d: DriveDisplay): String = listOfNotNull(
    speedLabel(d),
    limitLabel(d),
    d.weatherText?.takeIf { d.weatherKind != null },
    if (d.notDrivingAvailable) NOT_DRIVING else null
  ).joinToString(". ")

  /**
   * Everything the posted notification shows, as one string: an update whose key equals the posted
   * one is not posted again (an unchanged keepalive only re-arms the stale timer). [promoted]: drawn
   * as a Live Update (its colours and chip differ).
   */
  fun key(d: DriveDisplay, promoted: Boolean): String = listOf(
    title(d),
    d.speedTint ?: "",
    d.speeding.toString(),
    limitLine(d),
    weatherLine(d) ?: "",
    d.notDrivingAvailable.toString(),
    d.skyMid ?: "",
    d.accent ?: "",
    promoted.toString()
  ).joinToString("|")
}
