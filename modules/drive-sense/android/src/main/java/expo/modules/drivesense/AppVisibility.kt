package expo.modules.drivesense

import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import java.lang.ref.WeakReference

/**
 * Whether RoadWise is in front, for the rows' `appForeground` (README §5).
 *
 * In front: a RoadWise activity is started (visible), and it is not sharing a phone-sized screen in
 * split screen. A dialog over RoadWise (a permission prompt), the notification shade, the assistant
 * overlay, a chat bubble, a heads-up notification or another app's picture-in-picture all leave the
 * activity started. Leaving through Home, Recents or another app stops it. An activity stopped for
 * a configuration change (a rotation, a fold) is recreated and never counts as leaving. Split
 * screen counts as leaving only on a display whose smallest width is under 600 dp: on large screens
 * and desktop windowing every app runs in a window.
 *
 * Registered from `Application.onCreate` through [DriveSensePackage], before any activity; the
 * module's `OnCreate` registers late (seeded from the current activity) only if that hook never
 * ran. The counters are written on the main thread only and read from the capture thread.
 */
object AppVisibility : Application.ActivityLifecycleCallbacks {
  /** Smallest screen width (dp) from which split screen is a window, not a shared phone screen. */
  const val LARGE_SCREEN_DP = 600

  @Volatile
  private var started = 0

  @Volatile
  private var multiWindow = false

  /** Main thread only: the activity stopped for a configuration change, whose new instance starts next. */
  private var recreating: WeakReference<Activity>? = null

  /** Main thread only: the last started activity, sampled for split screen. */
  private var last: WeakReference<Activity>? = null

  private var registered = false
  private val main = Handler(Looper.getMainLooper())

  /** RoadWise is in front: started, and not sharing a phone screen in split screen. */
  fun inFront(): Boolean = started > 0 && !multiWindow

  /** Any RoadWise activity is started (split screen included). */
  fun visible(): Boolean = started > 0

  /** Application.onCreate. Idempotent. */
  fun register(app: Application) {
    synchronized(this) {
      if (registered) return
      registered = true
    }
    app.registerActivityLifecycleCallbacks(this)
  }

  /**
   * The fallback when the Package hook never ran (a custom MainApplication): registers now and
   * seeds one started activity when [current] exists. Does nothing once registered.
   */
  fun registerLate(app: Application, current: Activity?) {
    synchronized(this) {
      if (registered) return
      registered = true
    }
    main.post {
      if (current != null && started == 0) {
        started = 1
        last = WeakReference(current)
        sample()
      }
      app.registerActivityLifecycleCallbacks(this)
    }
  }

  /**
   * Main thread. Re-reads split screen from the last started activity (entering split screen is a
   * configuration change, not a lifecycle callback); the capture posts it once per row.
   */
  fun sample() {
    val a = last?.get()
    multiWindow = a != null &&
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.N &&
      a.isInMultiWindowMode &&
      a.resources.configuration.smallestScreenWidthDp < LARGE_SCREEN_DP
  }

  override fun onActivityStarted(activity: Activity) {
    if (recreating != null) {
      // The new instance of an activity recreated for a configuration change: it never left.
      recreating = null
    } else {
      started += 1
    }
    last = WeakReference(activity)
    sample()
  }

  override fun onActivityStopped(activity: Activity) {
    if (activity.isChangingConfigurations) {
      recreating = WeakReference(activity)
    } else {
      started = (started - 1).coerceAtLeast(0)
    }
    if (last?.get() === activity) last = null
    sample()
  }

  override fun onActivityDestroyed(activity: Activity) {
    // A recreation that never completed: the stopped activity is gone for good, and nothing replaced it.
    if (recreating?.get() === activity && !activity.isChangingConfigurations) {
      recreating = null
      started = (started - 1).coerceAtLeast(0)
    }
  }

  override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}

  override fun onActivityResumed(activity: Activity) {}

  override fun onActivityPaused(activity: Activity) {}

  override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
}
