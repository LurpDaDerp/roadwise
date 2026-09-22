package expo.modules.drivesense

import android.os.Handler
import android.os.Looper
import java.lang.ref.WeakReference

/**
 * Every event native emits goes through here (README §3 "Buffering", rev1: C2).
 *
 * An event emitted while no JS listener for THAT event is attached — before the bundle has loaded
 * (the `wake` that launched the process), or while JS is between listeners — is buffered in this
 * process and delivered, in order, when the first listener for it attaches (Expo
 * `OnStartObserving`), after `addListener` returns. The buffer holds at most [MAX_BUFFERED] events
 * across all names; when full, the oldest `row` goes first, else the oldest event.
 *
 * It also tracks whether a `row` listener is attached — the watchdog's liveness signal (README §6).
 */
object EventBus {
  /** Matches `EVENT_BUFFER_MAX` in `src/fake.ts`. */
  const val MAX_BUFFERED = 300

  fun interface Emitter {
    fun emit(name: String, body: Map<String, Any?>)
  }

  private data class Pending(val name: String, val body: Map<String, Any?>)

  private val lock = Any()
  private val buffer = ArrayDeque<Pending>()
  private val observed = HashSet<String>()
  private var emitter: WeakReference<Emitter>? = null
  private val main = Handler(Looper.getMainLooper())

  /** Called when the row-listener state changes (the capture service's watchdog). */
  @Volatile
  var rowListenerChanged: ((attached: Boolean) -> Unit)? = null

  val rowListenerAttached: Boolean
    get() = synchronized(lock) { observed.contains("row") && emitter?.get() != null }

  /** A new JS runtime's module instance takes over delivery. Its listeners start from none. */
  fun attach(e: Emitter) {
    synchronized(lock) {
      emitter = WeakReference(e)
      observed.clear()
    }
    rowListenerChanged?.invoke(false)
  }

  /** The module instance is going away (JS runtime torn down): nobody is listening any more. */
  fun detach(e: Emitter) {
    val wasRow: Boolean
    synchronized(lock) {
      if (emitter?.get() !== e) return
      wasRow = observed.contains("row")
      emitter = null
      observed.clear()
    }
    if (wasRow) rowListenerChanged?.invoke(false)
  }

  /** Expo `OnStartObserving(name)`: the first JS listener for [name] attached. */
  fun startObserving(name: String) {
    synchronized(lock) { observed.add(name) }
    // Deliver after addListener has returned (README §3).
    main.post { flush(name) }
    if (name == "row") rowListenerChanged?.invoke(true)
  }

  /** Expo `OnStopObserving(name)`: the last JS listener for [name] was removed. */
  fun stopObserving(name: String) {
    synchronized(lock) { observed.remove(name) }
    if (name == "row") rowListenerChanged?.invoke(false)
  }

  fun emit(name: String, body: Map<String, Any?>) {
    synchronized(lock) {
      val e = emitter?.get()
      if (e != null && observed.contains(name) && buffer.none { it.name == name }) {
        safeEmit(e, name, body)
        return
      }
      if (buffer.size >= MAX_BUFFERED) {
        val oldestRow = buffer.indexOfFirst { it.name == "row" }
        if (oldestRow >= 0) buffer.removeAt(oldestRow) else buffer.removeAt(0)
      }
      buffer.addLast(Pending(name, body))
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

  private fun safeEmit(e: Emitter, name: String, body: Map<String, Any?>) {
    try {
      e.emit(name, body)
    } catch (_: Exception) {
      // A torn-down runtime can throw here; the event is lost with the runtime (SR9: never surface).
    }
  }

}
