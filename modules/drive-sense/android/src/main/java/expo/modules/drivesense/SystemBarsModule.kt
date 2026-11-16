package expo.modules.drivesense

import android.app.Activity
import android.os.Build
import androidx.core.view.WindowCompat
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The navigation bar's button ink, set from JS (`src/ui/systemBars.ts`) so the bar at the foot of
 * the screen reads on what RoadWise draws there rather than on the phone's own theme.
 *
 * RoadWise runs edge to edge (React Native's `enableEdgeToEdge`, enforced from Android 15): the
 * navigation bar is transparent over the app, and its buttons (or the gesture handle) take the
 * light-or-dark appearance React Native set once, from the phone's Light / Dark setting, when the
 * activity was created. The app's own scheme (the sky, or a pinned Light / Dark look) and the
 * driving screen's true black can differ from the phone's, which left dark buttons on a dark page.
 *
 * - Android 10 (API 29) and up: only the appearance changes. The bar stays transparent; with
 *   three-button navigation the system draws its own contrast scrim, light or dark to match the
 *   appearance, so the buttons always read. Gesture navigation draws no scrim.
 * - Android 8 and 9 (API 26–28): there is no system scrim, so React Native painted the bar its own
 *   translucent white or dark grey for the phone's theme; it is repainted to match the new ink
 *   ([NavBarInk.scrimFor]), never left as white buttons on a white scrim.
 * - Below Android 8 a light navigation bar does not exist: nothing changes.
 *
 * The last ink asked for is kept and re-applied each time RoadWise comes to the front, so a
 * recreated activity (React Native sets the phone's appearance again in `onCreate`) never shows the
 * stale one. Window calls run on the main thread. Nothing here runs in the background or polls.
 */
class SystemBarsModule : Module() {
  /** True: light buttons (for a dark page). Null until JS asks: the phone's own appearance stays. */
  @Volatile
  private var lightInk: Boolean? = null

  override fun definition() = ModuleDefinition {
    Name("RoadWiseSystemBars")

    AsyncFunction("setNavigationBarInk") { ink: String ->
      lightInk = NavBarInk.parse(ink)
      apply(appContext.currentActivity)
    }.runOnQueue(Queues.MAIN)

    OnActivityEntersForeground {
      apply(appContext.currentActivity)
    }
  }

  @Suppress("DEPRECATION")
  private fun apply(activity: Activity?) {
    val light = lightInk ?: return
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val window = activity?.window ?: return
    try {
      WindowCompat.getInsetsController(window, window.decorView).isAppearanceLightNavigationBars = !light
      NavBarInk.scrimFor(Build.VERSION.SDK_INT, light)?.let { window.navigationBarColor = it }
    } catch (_: RuntimeException) {
      // A window torn down mid-call (the activity finishing): the next foreground applies it.
    }
  }
}

/** The pure half of [SystemBarsModule], held by JVM tests. */
object NavBarInk {
  /** React Native's own scrims (`WindowUtil.kt`), the platform's colours from API 29. */
  const val LIGHT_SCRIM: Int = 0xE6FFFFFF.toInt()
  const val DARK_SCRIM: Int = 0x801B1B1B.toInt()

  /** "light" or "dark" (the button ink, as the status bar's `style` names it); anything else: none. */
  fun parse(ink: String): Boolean? =
    when (ink) {
      "light" -> true
      "dark" -> false
      else -> null
    }

  /**
   * The bar colour to paint for [lightInk] on [sdk]: a dark scrim under light buttons, a light one
   * under dark buttons, on API 26–28 only. Null where the bar stays as it is (transparent from API
   * 29, where the system draws the scrim; untouched below 26).
   */
  fun scrimFor(sdk: Int, lightInk: Boolean): Int? =
    if (sdk < 26 || sdk >= 29) null else if (lightInk) DARK_SCRIM else LIGHT_SCRIM
}
