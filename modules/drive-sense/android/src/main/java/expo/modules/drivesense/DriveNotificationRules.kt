package expo.modules.drivesense

/**
 * The drive notification's timing and source rules (pure: no Android type, so the JVM tests hold
 * them). [DriveNotificationController] applies them under its lock.
 */
object DriveNotificationRules {
  /** What a foreground post ([DriveNotificationController.foreground]) shows. */
  enum class Source {
    /** The capture's own newest display (a start while recording, after an update). */
    DISPLAY,
    /** The state kept on disk for the open capture: only on a `START_STICKY` restart. */
    KEPT,
    /** What the controller already holds for the running capture (a start while recording, before any update). */
    CURRENT,
    /** A new capture: the empty state, and any kept state is forgotten (never a previous drive's). */
    EMPTY
  }

  /**
   * [hasDisplay]: the capture already has a display. [restart]: the system restarted the capture
   * after killing the process (`onStartCommand` with no intent). [capturing]: a capture already runs
   * in this process. A new capture never restores: the capture-open flag and the kept capture start
   * may still be a previous drive's (one killed mid-drive) when the foreground post runs, before the
   * new capture writes its own.
   */
  fun source(hasDisplay: Boolean, restart: Boolean, capturing: Boolean): Source = when {
    hasDisplay -> Source.DISPLAY
    restart -> Source.KEPT
    capturing -> Source.CURRENT
    else -> Source.EMPTY
  }

  /**
   * How long (ms, the boot clock) until a state that came at [latestAt] goes stale at [now]: 0 or
   * less, it is stale now. The stale timer asks it before it marks anything stale, as an update may
   * have come while the timer waited for the lock.
   */
  fun staleIn(now: Long, latestAt: Long): Long = DriveNotificationText.STALE_AFTER_MS - (now - latestAt)
}
