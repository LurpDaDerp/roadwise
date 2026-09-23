// The native half of the self-test (README §8.3). It runs the PRODUCTION classes (FeatureExtractor,
// Roi, HeadPose, RecordEncoder, Batcher, GazeInputAssembler, SubjectStatisticTracker, Focal, and the
// build's GazeNetFactory through `makeNet`) over the golden vectors and returns their outputs; JS
// diffs them. It never carries a copy of any production logic. JVM only (org.json is part of Android).

package expo.modules.dmsvision

import java.nio.ByteBuffer
import org.json.JSONArray
import org.json.JSONObject

object SelfTest {
  const val PLATFORM = "android"

  /**
   * `vectorsJson`: a JSON array of vectors. `gazeNetAvailable` / `makeNet` come from the build's
   * GazeNetFactory. Throws DmsError.badArgs if the input is not a JSON array at all.
   */
  fun run(vectorsJson: String, gazeNetAvailable: Boolean, makeNet: () -> GazeNetRunner?): String {
    val vectors = try {
      JSONArray(vectorsJson)
    } catch (e: Exception) {
      throw DmsError.badArgs("selfTest needs a JSON array of vectors")
    }
    var net: GazeNetRunner? = null
    val results = JSONArray()
    for (idx in 0 until vectors.length()) {
      val v = vectors.optJSONObject(idx) ?: JSONObject()
      val name = v.optString("name", "")
      val kind = v.optString("kind", "")
      val inputs = v.optJSONObject("inputs") ?: JSONObject()
      var result = JSONObject().put("name", name).put("kind", kind)
      try {
        when (kind) {
          "record" -> result.put("batch", record(inputs))
          "gazeInputs" -> result.put("frames", gazeInputs(inputs))
          "statsTracker" -> result.put("current", statsTracker(inputs))
          "headPose" -> result.put("poses", headPose(inputs))
          "batcher" -> result.put("cases", batcher(inputs))
          "focal" -> result.put("focalScales", focal(inputs))
          "onnx" -> if (!gazeNetAvailable) {
            result.put("skipped", "gaze net not built")
          } else {
            if (net == null) net = makeNet()
            val runner = net ?: throw DmsError.model("the gaze net could not be created")
            result.put("cases", onnx(inputs, runner))
          }
          else -> throw DmsError.badArgs("unknown vector kind $kind")
        }
      } catch (e: Exception) {
        result = JSONObject().put("name", name).put("kind", kind).put("error", e.message ?: e.toString())
      }
      results.put(result)
    }
    net?.close()
    return JSONObject()
      .put("version", 1)
      .put("platform", PLATFORM)
      .put("gazeNetAvailable", gazeNetAvailable)
      .put("results", results)
      .toString()
  }

  // JSON helpers

  private fun num(o: JSONObject, key: String): Double {
    if (!o.has(key) || o.isNull(key)) throw DmsError.badArgs("expected a number at $key")
    return o.getDouble(key)
  }

  private fun nums(a: JSONArray?): DoubleArray {
    a ?: throw DmsError.badArgs("expected an array of numbers")
    return DoubleArray(a.length()) { a.getDouble(it) }
  }

  /** null → NaN. */
  private fun numsOrNaN(a: JSONArray): DoubleArray = DoubleArray(a.length()) { if (a.isNull(it)) Double.NaN else a.getDouble(it) }

  private fun optionalNums(o: JSONObject, key: String): DoubleArray? =
    if (!o.has(key) || o.isNull(key)) null else nums(o.getJSONArray(key))

  private fun doubles(xs: DoubleArray): JSONArray = JSONArray().also { a -> xs.forEach { a.put(it) } }
  private fun floats(xs: FloatArray): JSONArray = JSONArray().also { a -> xs.forEach { a.put(it.toDouble()) } }

  // Kinds

  private class Image(val w: Int, val h: Int, val stride: Int, val bgra: Boolean, val bytes: ByteBuffer)

  private fun record(inputs: JSONObject): JSONObject {
    val images = inputs.getJSONArray("images")
    val frames = inputs.getJSONArray("frames")
    val anchorEpochMs = num(inputs, "anchorEpochMs")
    val pixels = (0 until images.length()).map { i ->
      val img = images.getJSONObject(i)
      val w = num(img, "w").toInt()
      val h = num(img, "h").toInt()
      val stride = num(img, "stride").toInt()
      val data = B64.decode(img.getString("pixels"))
      if (data.size != stride * h) throw DmsError.badArgs("image bytes ≠ stride·h")
      Image(w, h, stride, img.getString("format") == "bgra", ByteBuffer.wrap(data))
    }
    val records = ArrayList<DoubleArray>(frames.length())
    for (k in 0 until frames.length()) {
      val f = frames.getJSONObject(k)
      val i = num(f, "image").toInt()
      if (i >= pixels.size) throw DmsError.badArgs("record frame")
      val img = pixels[i]
      // The production reader, with the vector's own row stride and a 4-byte pixel (Task 2 review I1).
      val src = LumaSource(img.bytes, img.w, img.h, img.stride, 4, img.bgra)
      records.add(
        FeatureExtractor.buildRecord(
          FrameInput(
            num(f, "tMs"), img.w, img.h, num(f, "rotationDeg").toInt(), src,
            optionalNums(f, "landmarks"), optionalNums(f, "matrix"), optionalNums(f, "netGaze"),
            num(f, "latLandmarkMs"), num(f, "latTotalMs")
          )
        )
      )
    }
    val batch = RecordEncoder.encode(records) ?: throw DmsError.badArgs("record encoding")
    return JSONObject()
      .put("anchorTMs", batch.anchorTMs)
      .put("anchorEpochMs", anchorEpochMs)
      .put("n", batch.n)
      .put("data", B64.encode(batch.data))
  }

  private fun gazeInputs(inputs: JSONObject): JSONArray {
    val width = num(inputs, "width")
    val height = num(inputs, "height")
    val focal = num(inputs, "focalScale")
    val frames = inputs.getJSONArray("frames")
    val asm = GazeInputAssembler()
    val out = JSONArray()
    for (k in 0 until frames.length()) {
      val f = frames.getJSONObject(k)
      val tSec = num(f, "tSec")
      val lm = nums(f.getJSONArray("landmarks"))
      val p = asm.prepare(lm, width, height, focal) ?: throw DmsError.badArgs("degenerate face")
      val g = FeatureExtractor.geometry(lm, width.toInt(), height.toInt())
      val admitted = asm.admit(p.cloud64, tSec, g.right?.ear ?: Double.NaN, g.left?.ear ?: Double.NaN, g.right == null, g.left == null)
      out.put(
        JSONObject()
          .put("cloud", floats(p.cloud))
          .put("context", floats(p.context))
          .put("validity", floats(p.validity))
          .put("admitted", admitted)
      )
    }
    return out
  }

  private fun statsTracker(inputs: JSONObject): JSONArray {
    val mean = nums(inputs.getJSONArray("trainingMean"))
    val t = nums(inputs.getJSONArray("t"))
    val pushes = inputs.getJSONArray("pushes")
    val tracker = SubjectStatisticTracker(mean, num(inputs, "warmup").toInt(), num(inputs, "windowS"))
    val out = JSONArray()
    for (i in 0 until pushes.length()) out.put(doubles(tracker.push(numsOrNaN(pushes.getJSONArray(i)), t[i])))
    return out
  }

  private fun headPose(inputs: JSONObject): JSONArray {
    val cases = inputs.getJSONArray("cases")
    val out = JSONArray()
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      // The production path: the layout rule, then the pose (Task 2 review I2).
      val p = HeadPose.fromAnyLayout(nums(c.getJSONArray("matrix")), num(c, "rotationDeg").toInt())
      out.put(if (p == null) JSONObject.NULL else doubles(p))
    }
    return out
  }

  /** The production Batcher over each case's appends; each flush reports which append triggered it. */
  private fun batcher(inputs: JSONObject): JSONArray {
    val cases = inputs.getJSONArray("cases")
    val out = JSONArray()
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val interval = num(c, "intervalMs")
      val offset = num(c, "epochOffsetMs")
      val frames = c.getJSONArray("frames")
      val b = Batcher()
      val flushes = JSONArray()
      for (k in 0 until frames.length()) {
        val f = frames.getJSONObject(k)
        val t = num(f, "tMs")
        val now = num(f, "nowMs")
        b.append(FeatureExtractor.faceAbsentRecord(t, 0.0, 0, 0.0, 0.0), now, now + offset)
        if (b.isDue(now, interval)) {
          val n = b.count
          val p = b.flush() ?: throw DmsError.badArgs("batcher flush")
          flushes.put(JSONObject().put("after", k).put("n", n).put("anchorTMs", p["anchorTMs"]).put("anchorEpochMs", p["anchorEpochMs"]))
        }
      }
      out.put(JSONObject().put("flushes", flushes))
    }
    return out
  }

  /** Focal.focalScale per case (sensor fields, or null for the field-of-view fallback). */
  private fun focal(inputs: JSONObject): JSONArray {
    val cases = inputs.getJSONArray("cases")
    val out = JSONArray()
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      val s = if (c.isNull("sensor")) null else c.getJSONObject("sensor").let {
        SensorGeometry(
          num(it, "focalLengthMm"), num(it, "physicalWidthMm"), num(it, "physicalHeightMm"),
          num(it, "pixelArrayWidth").toInt(), num(it, "pixelArrayHeight").toInt(),
          num(it, "activeWidth").toInt(), num(it, "activeHeight").toInt()
        )
      }
      out.put(Focal.focalScale(s, num(c, "width").toInt(), num(c, "height").toInt(), num(c, "rotationDeg").toInt()))
    }
    return out
  }

  private fun onnx(inputs: JSONObject, runner: GazeNetRunner): JSONArray {
    val cases = inputs.getJSONArray("cases")
    val out = JSONArray()
    for (i in 0 until cases.length()) {
      val c = cases.getJSONObject(i)
      fun f32(key: String): FloatArray = nums(c.getJSONArray(key)).let { d -> FloatArray(d.size) { d[it].toFloat() } }
      val (gaze, rotation) = runner.run(f32("cloud"), f32("context"), f32("validity"))
      out.put(JSONObject().put("gaze", doubles(gaze)).put("rotation", doubles(rotation)))
    }
    return out
  }
}

/** Base64 without java.util.Base64 (API 26) or android.util.Base64 (not on a plain JVM). */
internal object B64 {
  private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

  fun encode(bytes: ByteArray): String {
    val out = StringBuilder((bytes.size + 2) / 3 * 4)
    var i = 0
    while (i < bytes.size) {
      val a = bytes[i].toInt() and 0xFF
      val b = if (i + 1 < bytes.size) bytes[i + 1].toInt() and 0xFF else 0
      val c = if (i + 2 < bytes.size) bytes[i + 2].toInt() and 0xFF else 0
      val n = (a shl 16) or (b shl 8) or c
      out.append(ALPHABET[(n shr 18) and 63]).append(ALPHABET[(n shr 12) and 63])
      out.append(if (i + 1 < bytes.size) ALPHABET[(n shr 6) and 63] else '=')
      out.append(if (i + 2 < bytes.size) ALPHABET[n and 63] else '=')
      i += 3
    }
    return out.toString()
  }

  fun decode(text: String): ByteArray {
    val clean = text.trimEnd('=')
    val out = ByteArray(clean.length * 3 / 4)
    var buffer = 0
    var bits = 0
    var o = 0
    for (ch in clean) {
      val v = ALPHABET.indexOf(ch)
      if (v < 0) throw DmsError.badArgs("invalid base64")
      buffer = (buffer shl 6) or v
      bits += 6
      if (bits >= 8) {
        bits -= 8
        out[o++] = ((buffer shr bits) and 0xFF).toByte()
      }
    }
    return out
  }
}
