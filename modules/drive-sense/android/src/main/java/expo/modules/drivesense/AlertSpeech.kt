package expo.modules.drivesense

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/**
 * The spoken words of drive alerts on Android: the phone's text-to-speech engine, bound on the
 * application context and owned by the process. expo-speech binds its engine to the activity and
 * shuts it down for good when the activity is destroyed, while on Android the drive (its location
 * service) and JS run on without one: every later phrase then went to a dead engine. This engine
 * outlives any activity, and one that dies (its service crashed, the engine was updated or removed)
 * is bound again at the next phrase or warm-up: a phrase it refuses, or a voice list it can't read. iPhone keeps expo-speech: nothing here runs there.
 * Main thread only (every entry point posts there; the engine's callbacks are posted back).
 */
internal object AlertSpeech {
  /** How long the engine has to answer its binding before it counts as failed. */
  private const val INIT_TIMEOUT_MS = 10_000L

  /** [onInit]'s status for a binding that never answered (none of TextToSpeech's). */
  private const val TIMED_OUT = Int.MIN_VALUE

  private val main = Handler(Looper.getMainLooper())
  private var tts: TextToSpeech? = null
  private var ready = false

  /** The last binding failed by never answering (read by the calls it hands null). */
  private var timedOut = false
  private val waiting = mutableListOf<(TextToSpeech?) -> Unit>()
  private val pending = HashMap<String, (String) -> Unit>()
  private var nextId = 0L

  /**
   * Speaks [text] at [volume] (0 to 1) after anything already queued; [done] gets `done`, `stopped`
   * or `error` (no engine, an engine that refused it or died). Never throws.
   */
  fun speak(context: Context, text: String, volume: Float, done: (String) -> Unit) {
    val app = context.applicationContext
    main.post {
      if (text.length > TextToSpeech.getMaxSpeechInputLength()) {
        done(SpeechOutcome.ERROR)
        return@post
      }
      withEngine(app) { t ->
        if (t == null) {
          done(SpeechOutcome.ERROR)
          return@withEngine
        }
        nextId += 1
        val id = "roadwise-$nextId"
        pending[id] = done
        val params = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, volume.coerceIn(0f, 1f)) }
        val code = try {
          t.language = Locale.getDefault()
          t.speak(text, TextToSpeech.QUEUE_ADD, params, id)
        } catch (_: Exception) {
          TextToSpeech.ERROR
        }
        // The engine's service is gone (it answers ERROR at once): bound again next time.
        if (code != TextToSpeech.SUCCESS) {
          settle(id, SpeechOutcome.ERROR)
          drop(t)
        }
      }
    }
  }

  /** Stops the phrase speaking and those queued: each answers `stopped`. */
  fun stop() {
    main.post {
      val t = tts
      if (t != null && ready) {
        try {
          t.stop()
        } catch (_: Exception) {
          // a dead engine: nothing is speaking
        }
      }
      settleAll(SpeechOutcome.STOPPED)
    }
  }

  /**
   * How many voices the engine has (binding it now): 0 only when a live engine has none or the phone
   * has no text-to-speech engine installed; null when it can't be read: a binding that never answered
   * or failed while an engine is installed (being updated, disabled for a moment), or an engine whose
   * service died (its voice list unreadable), let go and bound once more first. JS then keeps trying phrases, and
   * a phrase the engine refuses lets it go too.
   */
  fun voiceCount(context: Context, done: (Int?) -> Unit) {
    val app = context.applicationContext
    main.post { countVoices(app, rebind = true, done) }
  }

  private fun countVoices(app: Context, rebind: Boolean, done: (Int?) -> Unit) {
    withEngine(app) { t ->
      if (t == null) {
        done(VoiceCount.afterFailedBind(timedOut, enginesInstalled(app)))
        return@withEngine
      }
      val n = VoiceCount.read { t.voices }
      if (n != null) {
        done(n)
        return@withEngine
      }
      drop(t)
      if (rebind) countVoices(app, rebind = false, done) else done(null)
    }
  }

  /**
   * Whether any text-to-speech engine is installed (the services answering TTS_SERVICE, as
   * TextToSpeech.getEngines finds them; the manifest's <queries> makes them visible on Android 11+);
   * null when the package manager can't be asked.
   */
  private fun enginesInstalled(app: Context): Boolean? =
    try {
      app.packageManager.queryIntentServices(Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE), 0).isNotEmpty()
    } catch (_: Exception) {
      null
    }

  /** [then] gets the bound engine, or null when none could be bound. */
  private fun withEngine(app: Context, then: (TextToSpeech?) -> Unit) {
    val t = tts
    if (t != null && ready) {
      then(t)
      return
    }
    waiting += then
    if (t != null) return
    // The answer is posted, so `engine` is set by the time it is read; an answer from an engine
    // already let go (its timeout, a drop) is ignored.
    var engine: TextToSpeech? = null
    val created = TextToSpeech(app) { status -> main.post { onInit(engine, status) } }
    engine = created
    created.setOnUtteranceProgressListener(Progress)
    tts = created
    main.postDelayed({ onInit(created, TIMED_OUT) }, INIT_TIMEOUT_MS)
  }

  /** The engine [t] answered its binding (or timed out): the calls waiting on it go on. */
  private fun onInit(t: TextToSpeech?, status: Int) {
    if (t == null || t !== tts || ready) return
    val ok = status == TextToSpeech.SUCCESS
    timedOut = status == TIMED_OUT
    if (ok) {
      ready = true
    } else {
      try {
        t.shutdown()
      } catch (_: Exception) {
        // never bound
      }
      tts = null
    }
    val those = waiting.toList()
    waiting.clear()
    for (w in those) w(if (ok) t else null)
  }

  /**
   * The engine [t] died: let it go (bound again on the next call); its phrases answer `error`. One
   * already let go (a newer engine may be binding) is left as it is.
   */
  private fun drop(t: TextToSpeech) {
    if (t !== tts) return
    tts = null
    ready = false
    try {
      t.shutdown()
    } catch (_: Exception) {
      // already dead
    }
    settleAll(SpeechOutcome.ERROR)
  }

  private fun settle(id: String, outcome: String) {
    pending.remove(id)?.invoke(outcome)
  }

  private fun settleAll(outcome: String) {
    val those = pending.values.toList()
    pending.clear()
    for (p in those) p(outcome)
  }

  private object Progress : UtteranceProgressListener() {
    override fun onStart(utteranceId: String?) = Unit

    override fun onDone(utteranceId: String?) {
      utteranceId?.let { id -> main.post { settle(id, SpeechOutcome.DONE) } }
    }

    override fun onStop(utteranceId: String?, interrupted: Boolean) {
      utteranceId?.let { id -> main.post { settle(id, SpeechOutcome.STOPPED) } }
    }

    @Deprecated("Deprecated in Java")
    override fun onError(utteranceId: String?) {
      utteranceId?.let { id -> main.post { settle(id, SpeechOutcome.ERROR) } }
    }

    override fun onError(utteranceId: String?, errorCode: Int) {
      utteranceId?.let { id -> main.post { settle(id, SpeechOutcome.ERROR) } }
    }
  }
}

/**
 * The engine's voice list read: its size, or null when it can't be read. `getVoices()` answers null
 * only for an engine it can't reach (its service died or never bound); a live engine with no voice
 * answers an empty set.
 */
internal object VoiceCount {
  fun read(voices: () -> Collection<*>?): Int? =
    try {
      voices()?.size
    } catch (_: Exception) {
      null
    }

  /**
   * The count when no engine could be bound: 0 ("no voice") only when the phone has no engine
   * installed; a timeout, or a failed binding while one is installed (or when that can't be told), is
   * null, so the words stay on and the next phrase tries again.
   */
  fun afterFailedBind(timedOut: Boolean, enginesInstalled: Boolean?): Int? =
    if (!timedOut && enginesInstalled == false) 0 else null
}

/** What a spoken phrase came to (`speakAlert`'s answer; src/speech.ts reads it). */
object SpeechOutcome {
  const val DONE = "done"
  const val STOPPED = "stopped"
  const val ERROR = "error"
}
