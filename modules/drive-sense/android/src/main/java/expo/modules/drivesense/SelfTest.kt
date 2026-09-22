package expo.modules.drivesense

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/**
 * The on-device self-test (README §8 "Self-test protocol"). It runs the PRODUCTION classes over the
 * golden vectors exactly as `runVector` in `src/extract/vectors.ts` does: [FeatureExtractor],
 * [GravityFilter] and the capture path's own accelerometer conversion
 * [SensorSource.androidAccelToReference] — never a copy kept for testing — so a port that
 * forgot `/ G_MPS2` or its sign fails the `android-raw` vector here, not in the car.
 *
 * Android runs every kind; it never answers `skipped` (that form is iOS-only).
 */
object SelfTest {
  class InvalidInput(message: String) : Exception(message)

  /** @throws InvalidInput when [vectorsJson] is not a JSON array at all (→ `E_INVALID_INPUT`). */
  fun run(vectorsJson: String): String {
    val vectors = try {
      JSONArray(vectorsJson)
    } catch (e: JSONException) {
      throw InvalidInput("selfTest: the vectors JSON cannot be parsed: ${e.message}")
    }
    val results = JSONArray()
    for (i in 0 until vectors.length()) {
      val v = vectors.optJSONObject(i)
      val name = v?.optString("name", "") ?: ""
      val kind = v?.optString("kind", "") ?: ""
      results.put(
        try {
          if (v == null) throw IllegalArgumentException("vector $i is not an object")
          val inputs = v.getJSONObject("inputs")
          when (kind) {
            "extract" -> JSONObject()
              .put("name", name).put("kind", "extract").put("rows", rowsJson(runExtract(inputs)))
            "gravityFilter" -> JSONObject()
              .put("name", name).put("kind", "gravityFilter").put("batches", batchesJson(runGravity(inputs)))
            "androidRaw" -> JSONObject()
              .put("name", name).put("kind", "androidRaw").put("rows", rowsJson(runAndroidRaw(inputs)))
            else -> throw IllegalArgumentException("unknown vector kind '$kind'")
          }
        } catch (e: Exception) {
          JSONObject().put("name", name).put("kind", kind).put("error", e.message ?: e.javaClass.simpleName)
        }
      )
    }
    return JSONObject().put("version", 1).put("platform", "android").put("results", results).toString()
  }

  // ——— runners (vectors.ts runExtractInputs / runGravityInputs / runAndroidRawInputs) ———

  private fun runExtract(inputs: JSONObject): List<FeatureRow> {
    var state = FeatureExtractor.initialState()
    val rows = ArrayList<FeatureRow>()
    val seconds = inputs.getJSONArray("seconds")
    for (i in 0 until seconds.length()) {
      val s = seconds.getJSONObject(i)
      val imu = s.getJSONArray("imu").mapObjects { o ->
        ImuSample(o.getDouble("t"), vec(o.getJSONArray("ua")), vec(o.getJSONArray("g")), vec(o.getJSONArray("w")))
      }
      val out = FeatureExtractor.extractSecond(imu, fix(s), phone(s), s.getDouble("tsMs"), state)
      rows.add(out.row)
      state = out.state
    }
    return rows
  }

  private fun runGravity(inputs: JSONObject): List<List<ImuSample>> {
    var state = GravityFilter.initialState()
    val batches = inputs.getJSONArray("batches")
    val out = ArrayList<List<ImuSample>>()
    for (i in 0 until batches.length()) {
      val raw = batches.getJSONArray(i).mapObjects { o ->
        RawImuSample(o.getDouble("t"), vec(o.getJSONArray("a")), vec(o.getJSONArray("w")))
      }
      val r = GravityFilter.filter(raw, state)
      state = r.state
      out.add(r.imu)
    }
    return out
  }

  private fun runAndroidRaw(inputs: JSONObject): List<FeatureRow> {
    var gs = GravityFilter.initialState()
    var es = FeatureExtractor.initialState()
    val rows = ArrayList<FeatureRow>()
    val seconds = inputs.getJSONArray("seconds")
    for (i in 0 until seconds.length()) {
      val s = seconds.getJSONObject(i)
      val raw = s.getJSONArray("raw").mapObjects { o ->
        val values = o.getJSONArray("values")
        RawImuSample(
          o.getDouble("t"),
          SensorSource.androidAccelToReference(values.getDouble(0), values.getDouble(1), values.getDouble(2)),
          vec(o.getJSONArray("w"))
        )
      }
      val f = GravityFilter.filter(raw, gs)
      gs = f.state
      val out = FeatureExtractor.extractSecond(f.imu, fix(s), phone(s), s.getDouble("tsMs"), es)
      es = out.state
      rows.add(out.row)
    }
    return rows
  }

  // ——— JSON helpers ———

  private inline fun <T> JSONArray.mapObjects(f: (JSONObject) -> T): List<T> =
    (0 until length()).map { f(getJSONObject(it)) }

  private fun vec(a: JSONArray): Vec3 = Vec3(a.getDouble(0), a.getDouble(1), a.getDouble(2))

  private fun fix(s: JSONObject): FixSample? {
    if (!s.has("fix") || s.isNull("fix")) return null
    val f = s.getJSONObject("fix")
    return FixSample(
      t = f.getDouble("t"),
      lat = f.getDouble("lat"),
      lng = f.getDouble("lng"),
      hAcc = f.getDouble("hAcc"),
      speed = f.getDouble("speed"),
      speedAcc = f.getDouble("speedAcc"),
      course = f.getDouble("course"),
      alt = f.getDouble("alt")
    )
  }

  private fun phone(s: JSONObject): PhoneSample {
    val p = s.getJSONObject("phone")
    return PhoneSample(p.getBoolean("locked"), p.getBoolean("screenOn"), p.getBoolean("appForeground"))
  }

  private fun vecJson(v: Vec3): JSONArray = JSONArray().put(v.x).put(v.y).put(v.z)

  private fun rowsJson(rows: List<FeatureRow>): JSONArray {
    val a = JSONArray()
    for (r in rows) {
      val o = JSONObject()
      for ((k, v) in r.toMap()) o.put(k, v)
      a.put(o)
    }
    return a
  }

  private fun batchesJson(batches: List<List<ImuSample>>): JSONArray {
    val a = JSONArray()
    for (b in batches) {
      val batch = JSONArray()
      for (s in b) {
        batch.put(JSONObject().put("t", s.t).put("ua", vecJson(s.ua)).put("g", vecJson(s.g)).put("w", vecJson(s.w)))
      }
      a.put(batch)
    }
    return a
  }
}
