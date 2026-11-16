package expo.modules.drivesense

import android.os.Handler
import android.os.Looper
import java.lang.ref.WeakReference

/**
 * One module's events on their way to JS (README §3 "Buffering", rev1: C2): [EventBus] carries
 * DriveSense's, [DetectEventBus] DriveDetect's (`driveStarted`, `driveEnded`, the live
 * `detectState`), each with its own buffer, listeners and module instance, as iOS's two hubs do.
 *
 * An event emitted while no JS listener for THAT event is attached (before the bundle has loaded, a
 * sticky restart or a resumed drive that launched the process, or while JS is between listeners) is
 * buffered in this process and delivered, in order, when the first listener for it attaches (Expo
 * `OnStartObserving`), after `addListener` returns. Each buffer holds at most
 * [EventBus.MAX_BUFFERED] events across its names; when full, the oldest `row` goes first, else the
 * oldest event.
 */
open class EventQueue {
  private data class Pending(val name: String, val body: Map<String, Any?>)

  private val lock = Any()
  private val buffer = ArrayDeque<Pending>()
  private val observed = HashSet<String>()
  private var emitter: WeakReference<EventBus.Emitter>? = null
  private val main = Handler(Looper.getMainLooper())

  /** A listener for [name] attached or went away (the watchdog's `row` signal on [EventBus]). */
  protected open fun observedChanged(name: String, attached: Boolean) {}

  /** Whether a JS listener for [name] is attached now. */
  fun observing(name: String): Boolean = synchronized(lock) { observed.contains(name) && emitter?.get() != null }

  /** A new JS runtime's module instance takes over delivery. Its listeners start from none. */
  fun attach(e: EventBus.Emitter) {
    synchronized(lock) {
      emitter = WeakReference(e)
      observed.clear()
    }
    observedChanged("row", false)
  }

  /** The module instance is going away (JS runtime torn down): nobody is listening any more. */
  fun detach(e: EventBus.Emitter) {
    val was: List<String>
    synchronized(lock) {
      if (emitter?.get() !== e) return
      was = observed.toList()
      emitter = null
      observed.clear()
    }
    for (name in was) observedChanged(name, false)
  }

  /** Expo `OnStartObserving(name)`: the first JS listener for [name] attached. */
  fun startObserving(name: String) {
    synchronized(lock) { observed.add(name) }
    // Deliver after addListener has returned (README §3).
    main.post { flush(name) }
    observedChanged(name, true)
  }

  /** Expo `OnStopObserving(name)`: the last JS listener for [name] was removed. */
  fun stopObserving(name: String) {
    synchronized(lock) { observed.remove(name) }
    observedChanged(name, false)
  }

  fun emit(name: String, body: Map<String, Any?>) {
    synchronized(lock) {
      val e = emitter?.get()
      if (e != null && observed.contains(name) && buffer.none { it.name == name }) {
        safeEmit(e, name, body)
        return
      }
      if (buffer.size >= EventBus.MAX_BUFFERED) {
        val oldestRow = buffer.indexOfFirst { it.name == "row" }
        if (oldestRow >= 0) buffer.removeAt(oldestRow) else buffer.removeAt(0)
      }
      buffer.addLast(Pending(name, body))
    }
  }

  /**
   * An event that only matters now (the DashPal link service's tick, the detector's state): sent
   * while a JS listener for it is attached, else dropped. Never buffered, so nothing piles up while
   * JS is away.
   */
  fun emitLive(name: String, body: Map<String, Any?>) {
    synchronized(lock) {
      val e = emitter?.get() ?: return
      if (!observed.contains(name)) return
      safeEmit(e, name, body)
    }
  }

  private fun flush(name: String) {
    synchronized(lock) {
      val e = emitter?.get() ?: return
      if (!observed.contains(name)) return
      val iter = buffer.iterator()
      val out = ArrayList<Pending>()
      while (iter.hasNext()) {
        val p = iter.next()
        if (p.name == name) {
          out.add(p)
          iter.remove()
        }
      }
      for (p in out) safeEmit(e, p.name, p.body)
    }
  }

  private fun safeEmit(e: EventBus.Emitter, name: String, body: Map<String, Any?>) {
    try {
      e.emit(name, body)
    } catch (_: Exception) {
      // A torn-down runtime can throw here; the event is lost with the runtime (SR9: never surface).
    }
  }
}

/**
 * DriveSense's events (every one the `DriveSense` module declares). It also tracks whether a `row`
 * listener is attached: the watchdog's liveness signal for a plain capture (README §6).
 */
object EventBus : EventQueue() {
  /** Matches `EVENT_BUFFER_MAX` in `src/fake.ts`. */
  const val MAX_BUFFERED = 300

  fun interface Emitter {
    fun emit(name: String, body: Map<String, Any?>)
  }

  /** Called when the row-listener state changes (the capture service's watchdog). */
  @Volatile
  var rowListenerChanged: ((attached: Boolean) -> Unit)? = null

  val rowListenerAttached: Boolean
    get() = observing("row")

  override fun observedChanged(name: String, attached: Boolean) {
    if (name == "row") rowListenerChanged?.invoke(attached)
  }
}

/**
 * DriveDetect's events: `driveStarted` and `driveEnded` buffered for the first listener (a resumed
 * drive's JS may not have loaded yet), `detectState` live only (JS reads the state with `getState`,
 * so a state nobody hears is dropped rather than buffered, where it would push the drive events out).
 */
object DetectEventBus : EventQueue()
