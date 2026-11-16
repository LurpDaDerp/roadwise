package expo.modules.drivesense

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The text-to-speech engine's voice list as AlertSpeech reads it (pure JVM): a live engine's set
 * gives its size (0 for none, the only "no voice"), while the null `getVoices()` answers for an
 * engine it can't reach, or a read that throws, give null (a dead engine: let go and bound again).
 */
class VoiceCountTest {
  @Test
  fun `a live engine's list gives its size, an empty one 0`() {
    assertEquals(3, VoiceCount.read { setOf("en-us", "en-gb", "fr-fr") })
    assertEquals(0, VoiceCount.read { emptySet<String>() })
  }

  @Test
  fun `a dead engine's null list or a read that throws gives null, never 0`() {
    assertNull(VoiceCount.read { null })
    assertNull(VoiceCount.read { throw IllegalStateException("not bound to TTS engine") })
  }

  @Test
  fun `a failed binding is no voice only when no engine is installed`() {
    assertEquals(0, VoiceCount.afterFailedBind(timedOut = false, enginesInstalled = false))
    // An installed engine that failed to bind (being updated, disabled for a moment) keeps the words.
    assertNull(VoiceCount.afterFailedBind(timedOut = false, enginesInstalled = true))
    assertNull(VoiceCount.afterFailedBind(timedOut = false, enginesInstalled = null))
    assertNull(VoiceCount.afterFailedBind(timedOut = true, enginesInstalled = false))
    assertNull(VoiceCount.afterFailedBind(timedOut = true, enginesInstalled = true))
  }
}
