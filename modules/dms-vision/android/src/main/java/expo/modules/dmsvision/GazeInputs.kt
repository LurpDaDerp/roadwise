// Port of src/reference/gazeInputs.ts and decayingHistogram.ts: the gaze network's inputs and the
// subject-statistic tracker. Compiled on every build (the self-test pins it). Only DMS_GAZE_NET=1
// builds run the network itself. JVM only.

package expo.modules.dmsvision

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.truncate

/** One batch-1 pass of the gaze network: cloud (1434), context (7), validity (478) → gaze (3) + rotation (9). */
interface GazeNetRunner {
  fun run(cloud: FloatArray, context: FloatArray, validity: FloatArray): Pair<DoubleArray, DoubleArray>
  fun close()
}

object GazeInputs {
  val TRAINING_MEAN = doubleArrayOf(0.3145948052406311, -0.022462697699666023, -0.21199138462543488, -0.9008664488792419)
  const val STAT_WARMUP_FRAMES = 30
  const val STAT_WINDOW_S = 120.0
  const val STAT_HIST_LO = -0.2
  const val STAT_HIST_HI = 0.2
  const val STAT_HIST_BIN = 0.0025
  /** Gates ONLY the net's subject statistics (internal builds), never a closure rule. */
  const val STAT_ADMIT_MIN_EAR = 0.18

  /** [cornerA, cornerB, iris, upper, lower, brow] and the sign, per eye. */
  private val statEyes = arrayOf(intArrayOf(33, 133, 468, 159, 145, 105), intArrayOf(263, 362, 473, 386, 374, 334))
  private val statSigns = doubleArrayOf(1.0, -1.0)

  /** Eye-centred, interocular-normalised weak-3D cloud; null when degenerate. */
  fun weak3dCloud(lm: DoubleArray, width: Double, height: Double): DoubleArray? {
    val ratio = height / width
    val r = Landmarks.outerCorners[0]
    val l = Landmarks.outerCorners[1]
    val cx = 0.5 * (lm[r * 3] + lm[l * 3])
    val cy = 0.5 * (lm[r * 3 + 1] * ratio + lm[l * 3 + 1] * ratio)
    val cz = 0.5 * (lm[r * 3 + 2] + lm[l * 3 + 2])
    val out = DoubleArray(Landmarks.FLOATS)
    for (i in 0 until Landmarks.COUNT) {
      out[i * 3] = lm[i * 3] - cx
      out[i * 3 + 1] = lm[i * 3 + 1] * ratio - cy
      out[i * 3 + 2] = lm[i * 3 + 2] - cz
    }
    val scale = hypot(out[r * 3] - out[l * 3], out[r * 3 + 1] - out[l * 3 + 1])
    if (!scale.isFinite() || scale < 1e-8) return null
    for (i in out.indices) out[i] /= scale
    return out
  }

  /** [ray_x, ray_y, iod / focal]; null when degenerate. */
  fun cameraContext(lm: DoubleArray, width: Double, height: Double, focalScale: Double): DoubleArray? {
    if (!focalScale.isFinite() || focalScale <= 0) return null
    val ratio = height / width
    val r = Landmarks.outerCorners[0]
    val l = Landmarks.outerCorners[1]
    val rx = lm[r * 3]
    val ry = lm[r * 3 + 1] * ratio
    val lx = lm[l * 3]
    val ly = lm[l * 3 + 1] * ratio
    val centerX = 0.5 * (rx + lx)
    val centerY = 0.5 * (ry + ly)
    val iod = hypot(rx - lx, ry - ly)
    if (!iod.isFinite() || iod < 1e-8) return null
    return doubleArrayOf((centerX - 0.5) / focalScale, (centerY - 0.5 * ratio) / focalScale, iod / focalScale)
  }

  fun landmarkValidity(lm: DoubleArray): FloatArray =
    FloatArray(Landmarks.COUNT) { if (Landmarks.inFrame(lm, it)) 1f else 0f }

  fun rowStatistics(c: DoubleArray): DoubleArray? {
    val out = DoubleArray(4)
    for (e in 0 until 2) {
      val idx = statEyes[e]
      val a = idx[0]
      val b = idx[1]
      val iris = idx[2]
      val upper = idx[3]
      val lower = idx[4]
      val brow = idx[5]
      val sign = statSigns[e]
      val centreX = 0.5 * (c[a * 3] + c[b * 3])
      val centreY = 0.5 * (c[a * 3 + 1] + c[b * 3 + 1])
      var ux = c[b * 3] - c[a * 3]
      var uy = c[b * 3 + 1] - c[a * 3 + 1]
      val width = hypot(ux, uy)
      if (!width.isFinite() || width < 1e-8) return null
      ux /= width
      uy /= width
      val vx = -uy
      val vy = ux
      fun alongV(i: Int): Double = (((c[i * 3] - centreX) * vx + (c[i * 3 + 1] - centreY) * vy) / width) * sign
      val up = alongV(upper)
      val lo = alongV(lower)
      val ir = alongV(iris)
      val br = alongV(brow)
      out[0] += abs(up - lo)
      out[1] += ir - 0.5 * (up + lo)
      out[2] += up
      out[3] += br
    }
    for (k in 0 until 4) out[k] *= 0.5
    return out
  }
}

/** numpy's pairwise summation (bit-comparable with the reference). */
fun dmsPairwiseSum(a: DoubleArray, off: Int, n: Int): Double {
  if (n < 8) {
    var res = 0.0
    for (i in 0 until n) res += a[off + i]
    return res
  }
  if (n <= 128) {
    val r = DoubleArray(8) { a[off + it] }
    var i = 8
    val lim = n - (n % 8)
    while (i < lim) {
      for (k in 0 until 8) r[k] += a[off + i + k]
      i += 8
    }
    var res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]))
    while (i < n) { res += a[off + i]; i += 1 }
    return res
  }
  var n2 = n / 2
  n2 -= n2 % 8
  return dmsPairwiseSum(a, off, n2) + dmsPairwiseSum(a, off + n2, n - n2)
}

fun dmsRoundHalfEven(x: Double): Double {
  val f = floor(x)
  val diff = x - f
  if (diff > 0.5) return f + 1
  if (diff < 0.5) return f
  return if (f % 2 == 0.0) f else f + 1
}

class DecayingHistogram1D(val lo: Double, val hi: Double, binWidth: Double, tauS: Double) {
  val bin = binWidth
  val n = max(1, dmsRoundHalfEven((hi - lo) / binWidth).toInt())
  val tau = tauS
  private val counts = DoubleArray(n)
  private var scale = 1.0
  private var tLast: Double? = null
  private var sum = 0.0
  private var dirty = false

  fun reset() {
    counts.fill(0.0)
    scale = 1.0
    tLast = null
    sum = 0.0
    dirty = false
  }

  private fun rawSum(): Double {
    if (dirty) { sum = dmsPairwiseSum(counts, 0, n); dirty = false }
    return sum
  }

  private fun advance(t: Double) {
    val last = tLast
    if (last != null && tau > 0) {
      val dt = max(0.0, t - last)
      scale *= exp(-dt / tau)
      if (scale < 1e-3) {
        for (i in 0 until n) counts[i] *= scale
        scale = 1.0
        dirty = true
      }
    }
    tLast = t
  }

  fun add(x: Double, t: Double, w: Double = 1.0) {
    advance(t)
    if (!x.isFinite() || w <= 0) return
    var i = truncate((x - lo) / bin).toInt() // toward zero, as the reference's Math.trunc
    i = min(max(i, 0), n - 1)
    counts[i] += w / scale
    dirty = true
  }

  fun quantile(q: Double): Double? {
    val total = rawSum()
    if (total <= 0) return null
    val target = min(max(q, 0.0), 1.0) * total
    var acc = 0.0
    for (i in 0 until n) {
      acc += counts[i]
      if (acc >= target) {
        val prev = acc - counts[i]
        val frac = if (counts[i] > 0) (target - prev) / counts[i] else 0.5
        return lo + (i + frac) * bin
      }
    }
    return hi
  }
}

class SubjectStatisticTracker(
  trainingMean: DoubleArray = GazeInputs.TRAINING_MEAN,
  private val warmup: Int = GazeInputs.STAT_WARMUP_FRAMES,
  windowS: Double = GazeInputs.STAT_WINDOW_S
) {
  private val defaults = trainingMean.copyOf()
  private val hists = Array(4) { k ->
    DecayingHistogram1D(
      trainingMean[k] + GazeInputs.STAT_HIST_LO * 4.0,
      trainingMean[k] + GazeInputs.STAT_HIST_HI * 4.0,
      GazeInputs.STAT_HIST_BIN, windowS
    )
  }
  private var count = 0

  fun reset() {
    for (h in hists) h.reset()
    count = 0
  }

  fun push(stats: DoubleArray, t: Double): DoubleArray {
    if (stats.all { it.isFinite() }) {
      for (k in 0 until 4) hists[k].add(stats[k], t)
      count += 1
    }
    return current()
  }

  fun current(): DoubleArray {
    val out = defaults.copyOf()
    if (count < warmup) return out
    for (k in 0 until 4) hists[k].quantile(0.5)?.let { out[k] = it }
    return out
  }
}

class PreparedGazeInputs(val cloud: FloatArray, val context: FloatArray, val validity: FloatArray, val cloud64: DoubleArray)

/**
 * The per-session assembler: `prepare` uses the tracker state BEFORE the frame; `admit` adds this
 * frame's statistics only for two open, unclipped eyes.
 */
class GazeInputAssembler {
  val tracker = SubjectStatisticTracker()

  fun reset() = tracker.reset()

  fun prepare(upright: DoubleArray, width: Double, height: Double, focalScale: Double): PreparedGazeInputs? {
    val cloud64 = GazeInputs.weak3dCloud(upright, width, height) ?: return null
    val ctx3 = GazeInputs.cameraContext(upright, width, height, focalScale) ?: return null
    val stats = tracker.current()
    val context = FloatArray(7) { if (it < 3) ctx3[it].toFloat() else stats[it - 3].toFloat() }
    return PreparedGazeInputs(FloatArray(cloud64.size) { cloud64[it].toFloat() }, context, GazeInputs.landmarkValidity(upright), cloud64)
  }

  fun admit(cloud64: DoubleArray, tSec: Double, earR: Double, earL: Double, clippedR: Boolean, clippedL: Boolean): Boolean {
    if (clippedR || clippedL || !earR.isFinite() || !earL.isFinite()) return false
    if (0.5 * (earR + earL) < GazeInputs.STAT_ADMIT_MIN_EAR) return false
    val stats = GazeInputs.rowStatistics(cloud64) ?: return false
    if (!stats.all { it.isFinite() }) return false
    tracker.push(stats, tSec)
    return true
  }
}
