package expo.modules.drivesense.detect

/**
 * Whether a wake registration is still on file with Play services. A reboot or an update drops
 * every one (the boot receiver sets them again); so does a force stop (Settings, an OEM cleaner,
 * Task Manager's Stop), which cancels every PendingIntent RoadWise holds, after which Play services
 * can deliver nothing and drops the registration. A PendingIntent the system no longer holds is the
 * sign (an ordinary process death leaves it, as Play services still holds it). Pure.
 */
object WakeFile {
  /**
   * The parked geofence must be set again: detection is not off, a parked spot is kept, and either
   * Play services dropped or refused the geofence ([owed]: location switched off) or its
   * PendingIntent is gone ([intentAlive], asked only when the rest holds: it is a call to the system).
   */
  fun parkedOwed(off: Boolean, parked: Boolean, owed: Boolean, intentAlive: () -> Boolean): Boolean =
    !off && parked && (owed || !intentAlive())
}
