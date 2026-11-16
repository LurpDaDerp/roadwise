package expo.modules.drivesense.detect

import expo.modules.drivesense.SelfTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * Every row of the drive detector's decision table (`src/detect/vectors.ts`) through the Android
 * policy, on the JVM. The rows come from `src/test/resources/detect-vectors.json`, which Jest holds
 * to a fresh generation of the table (`__tests__/detectFixture.test.ts`): each is the wire vector
 * the phone's self-test sends plus the row's `expected`. They go in through [SelfTest.run], the
 * on-device entry point, so the routing of `detect` vectors is under test too, and each answer is
 * matched with the rules of `matchDetectRow` in `src/detect/selfTest.ts` (numbers within 1e-6, null
 * and missing alike, arrays whole, only the expected keys of an object).
 */
class DetectPolicyVectorsTest {
  private val fixture: JSONArray by lazy {
    val stream = javaClass.classLoader!!.getResourceAsStream("detect-vectors.json")
      ?: error("detect-vectors.json is not on the test classpath (src/test/resources)")
    JSONArray(stream.bufferedReader(Charsets.UTF_8).use { it.readText() })
  }

  private fun rows(): List<JSONObject> = (0 until fixture.length()).map { fixture.getJSONObject(it) }

  @Test
  fun `the fixture holds every row kind of the decision table`() {
    val kinds = rows().map { it.getJSONObject("inputs").getString("kind") }.toSet()
    assertEquals(
      setOf(
        "confirm", "trace", "slow", "link", "car", "start", "summary", "motionGate", "veto", "wake",
        "candidate", "startsAfter", "end", "suppress", "suppressResume", "resume", "resumeSeq", "status"
      ),
      kinds
    )
    assertTrue("the table has its rows", rows().size > 150)
  }

  @Test
  fun `the self-test answers every row as the reference does`() {
    val wire = JSONArray()
    for (r in rows()) wire.put(JSONObject().put("name", r.getString("name")).put("kind", "detect").put("inputs", r.getJSONObject("inputs")))
    val output = JSONObject(SelfTest.run(wire.toString()))
    assertEquals(1, output.getInt("version"))
    assertEquals("android", output.getString("platform"))
    val results = output.getJSONArray("results")
    assertEquals(fixture.length(), results.length())

    val failures = ArrayList<String>()
    rows().forEachIndexed { i, row ->
      val name = row.getString("name")
      val r = results.getJSONObject(i)
      when {
        r.optString("name") != name -> failures.add("$name: answered as '${r.optString("name")}'")
        r.optString("kind") != "detect" -> failures.add("$name: kind '${r.optString("kind")}'")
        r.has("skipped") -> failures.add("$name: skipped (${r.get("skipped")})")
        r.has("error") -> failures.add("$name: error ${r.get("error")}")
        r.optJSONObject("actual") == null -> failures.add("$name: no actual")
        else -> {
          val mismatches = ArrayList<String>()
          within("", row.getJSONObject("expected"), r.getJSONObject("actual"), mismatches)
          if (mismatches.isNotEmpty()) failures.add("$name: ${mismatches.take(5).joinToString("; ")}")
        }
      }
    }
    assertTrue("${failures.size} of ${fixture.length()} rows differ from the reference:\n" + failures.joinToString("\n"), failures.isEmpty())
  }

  /** `within` in src/detect/selfTest.ts. */
  private fun within(path: String, expected: Any?, actual: Any?, out: MutableList<String>) {
    fun miss() = out.add("$path: expected $expected, got $actual")
    val a = if (actual == JSONObject.NULL) null else actual
    when (expected) {
      null, JSONObject.NULL -> if (a != null) miss()
      is Number -> if (a !is Number || abs(a.toDouble() - expected.toDouble()) > 1e-6) miss()
      is JSONArray -> {
        if (a !is JSONArray || a.length() != expected.length()) {
          miss()
          return
        }
        for (i in 0 until expected.length()) within("$path[$i]", expected.get(i), a.get(i), out)
      }
      is JSONObject -> {
        if (a !is JSONObject) {
          miss()
          return
        }
        for (k in expected.keys()) within(if (path.isEmpty()) k else "$path.$k", expected.get(k), if (a.has(k)) a.get(k) else null, out)
      }
      else -> if (expected != a) miss()
    }
  }
}
