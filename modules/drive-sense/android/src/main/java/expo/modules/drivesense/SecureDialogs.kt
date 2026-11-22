package expo.modules.drivesense

import android.view.Window
import android.view.WindowManager
import com.facebook.react.interfaces.ExtraWindowEventListener
import java.util.Collections
import java.util.WeakHashMap

/**
 * FLAG_SECURE on React Native's Modal dialogs while the DashPal aiming picture shows (setup's
 * screen 3 and the re-aim sheet), so screenshots, screen recordings and the app switcher never
 * show the driver's face.
 *
 * expo-screen-capture secures the activity's window only. A React Native Modal on Android is a
 * separate Dialog window, which copies FLAG_SECURE from the activity once, when it is created: the
 * setup sheet is created at its first step, long before the picture, and the re-aim sheet in the
 * same moment the picture's screen mounts, so neither is secured by the activity's flag. React
 * Native reports every Modal dialog it shows and dismisses (`ExtraWindowEventListener`); this keeps
 * them, and while anything holds the picture's guard each one carries FLAG_SECURE, a dialog opened
 * meanwhile included. The last hold let go clears the flag again. Every call runs on the main
 * thread (React Native's window events, and `secureDialogs` on `Queues.MAIN`). iOS needs none of
 * this: expo-screen-capture's protection covers the whole key window, Modals included.
 */
class SecureDialogs<W : Any>(private val secure: (W) -> Unit, private val clear: (W) -> Unit) {
  /** The dialogs on screen now: weak, so a dialog React Native never reports dismissed is not kept. */
  private val windows: MutableSet<W> = Collections.newSetFromMap(WeakHashMap<W, Boolean>())

  /** The holds of the screens showing the picture (each mount's own key, as expo-screen-capture's tags). */
  private val holds = HashSet<String>()

  val isSecure: Boolean
    get() = holds.isNotEmpty()

  /** A dialog came on screen: secured at once while the picture is held. */
  fun opened(window: W) {
    if (windows.add(window) && isSecure) secure(window)
  }

  /** A dialog left the screen. */
  fun closed(window: W) {
    windows.remove(window)
  }

  /** A screen showing the picture holds the guard: the first hold secures every dialog on screen. */
  fun hold(key: String) {
    val was = isSecure
    holds.add(key)
    if (!was) windows.toList().forEach(secure)
  }

  /** That screen lets go: the last hold clears the flag from every dialog on screen. A key not held changes nothing. */
  fun release(key: String) {
    if (holds.remove(key) && holds.isEmpty()) windows.toList().forEach(clear)
  }
}

/** [SecureDialogs] on React Native's Modal dialog windows, registered with the React context by DriveSenseModule. */
class SecureDialogWindows : ExtraWindowEventListener {
  val dialogs = SecureDialogs<Window>(
    secure = { flag(it, true) },
    clear = { flag(it, false) }
  )

  override fun onExtraWindowCreate(window: Window) = dialogs.opened(window)

  override fun onExtraWindowDestroy(window: Window) = dialogs.closed(window)

  private fun flag(window: Window, on: Boolean) {
    try {
      if (on) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE) else window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    } catch (_: RuntimeException) {
      // A dialog torn down mid-call: its window is gone, and with it the picture.
    }
  }
}
