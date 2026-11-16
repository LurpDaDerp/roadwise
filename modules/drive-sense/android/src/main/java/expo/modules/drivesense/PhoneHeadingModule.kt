package expo.modules.drivesense

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * `PhoneHeading` (Android only, README §12): the phone's compass heading for the driving screen's
 * compass before a drive's first direction of travel, from [HeadingSource]. Its own module, so the
 * shared DriveSense surface (the same events and methods on both platforms) is untouched; on iOS the
 * compass reads expo-location's heading and this module does not exist.
 *
 * Sync functions: `available()` (the phone has a rotation-vector sensor), `start()` (true once the
 * sensor runs; false without one) and `stop()`. Starts and stops are counted, so two screens asking
 * at once share one sensor and it stops with the last `stop`; the JS runtime going away stops it
 * whatever the count. `heading` events `{ trueHeading, magHeading, accuracy }` (the shape of
 * expo-location's heading: `trueHeading` -1 when no location is known yet, `accuracy` 0-3) are
 * sent while it runs and a JS listener is attached; never buffered (a stale heading is worthless).
 */
class PhoneHeadingModule : Module() {
  private val lock = Any()
  private var source: HeadingSource? = null
  private var users = 0

  private fun stopAll() {
    synchronized(lock) {
      users = 0
      source?.stop()
    }
  }

  override fun definition() = ModuleDefinition {
    Name("PhoneHeading")

    Events("heading")

    Function("available") {
      val context = appContext.reactContext ?: return@Function false
      HeadingSource.sensor(context) != null
    }

    Function("start") {
      synchronized(lock) {
        val context = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()
        val s = source ?: HeadingSource(context) { body -> sendEvent("heading", body) }.also { source = it }
        if (!s.start()) return@Function false
        users += 1
        true
      }
    }

    Function("stop") {
      synchronized(lock) {
        if (users > 0) {
          users -= 1
          if (users == 0) source?.stop()
        }
      }
      Unit
    }

    OnDestroy { stopAll() }
  }
}
