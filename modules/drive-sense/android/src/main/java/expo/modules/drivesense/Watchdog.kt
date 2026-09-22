package expo.modules.drivesense

import android.os.Handler
import android.os.SystemClock

/**
 * Capture nobody records must stop (README §6, rev1: C2). Only JS can decide a drive is over, and
 * only JS can stop this service — so if the headless boot fails, 1 Hz GPS and 25 Hz IMU would run
 * for hours under a "Recording your drive" notification. Two rules:
 *
 * 1. **Claim within 60 s.** A capture native started by itself (the activity-transition receiver, a
 *    `START_STICKY` restart) must be claimed by a JS `startCapture` within [CLAIM_TIMEOUT_MS].
 * 2. **A row listener must exist.** While capturing, no JS `row` listener for [NO_ROW_LISTENER_MS]
 *    continuously (Expo `OnStartObserving`/`OnStopObserving` for `row`, or the JS runtime torn down).
 *
 * Either way [onExpire] runs: the service stops capture, clears the capturing and capture-open
 * flags, stops the foreground service and records exit reason `watchdog`. No JS timer or heartbeat
 * is involved. Deadlines are on the boot clock (`elapsedRealtime`, which keeps counting in deep
 * sleep) and are also checked on every row or fix via [check], so a handler delayed by sleep cannot
 * stretch them. Everything here runs on the capture thread ([handler]).
 */
class Watchdog(private val handler: Handler, private val onExpire: (String) -> Unit) {
  companion object {
    const val CLAIM_TIMEOUT_MS = 60_000L
    const val NO_ROW_LISTENER_MS = 300_000L
  }

  private var active = false
  private var claimDeadline: Long? = null
  private var listenerDeadline: Long? = null
  private val tick = Runnable { check() }

  /** Capture started. [nativeStart]: native started it itself, so JS must claim it. */
  fun start(nativeStart: Boolean, rowListenerAttached: Boolean) {
    active = true
    claimDeadline = if (nativeStart) SystemClock.elapsedRealtime() + CLAIM_TIMEOUT_MS else null
    listenerDeadline = if (rowListenerAttached) null else SystemClock.elapsedRealtime() + NO_ROW_LISTENER_MS
    schedule()
  }

  /** JS called `startCapture`: the capture is claimed. */
  fun claim() {
    claimDeadline = null
    schedule()
  }

  /** The `row` listener state changed (from [EventBus], any thread). */
  fun onRowListener(attached: Boolean) {
    handler.post {
      if (!active) return@post
      listenerDeadline = if (attached) null else (listenerDeadline ?: (SystemClock.elapsedRealtime() + NO_ROW_LISTENER_MS))
      schedule()
    }
  }

  fun stop() {
    active = false
    claimDeadline = null
    listenerDeadline = null
    handler.removeCallbacks(tick)
  }

  /** Expire a passed deadline; called by the timer and on every row or fix. */
  fun check() {
    if (!active) return
    val now = SystemClock.elapsedRealtime()
    val claim = claimDeadline
    val listener = listenerDeadline
    when {
      claim != null && now >= claim -> expire("claim")
      listener != null && now >= listener -> expire("rowListener")
      else -> schedule()
    }
  }

  private fun expire(why: String) {
    stop()
    onExpire(why)
  }

  private fun schedule() {
    handler.removeCallbacks(tick)
    if (!active) return
    val next = listOfNotNull(claimDeadline, listenerDeadline).minOrNull() ?: return
    handler.postDelayed(tick, (next - SystemClock.elapsedRealtime()).coerceAtLeast(0L))
  }
}
