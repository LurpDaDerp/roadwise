// Port of src/reference/gazeInputs.ts and decayingHistogram.ts: the gaze network's inputs and the
// subject-statistic tracker. Compiled on every build (the self-test pins it). Only DMS_GAZE_NET=1
// builds run the network itself. Foundation only.

import Foundation

enum GazeInputs {
  static let TRAINING_MEAN: [Double] = [0.3145948052406311, -0.022462697699666023, -0.21199138462543488, -0.9008664488792419]
  static let STAT_WARMUP_FRAMES = 30
  static let STAT_WINDOW_S = 120.0
  static let STAT_HIST_LO = -0.2
  static let STAT_HIST_HI = 0.2
  static let STAT_HIST_BIN = 0.0025
  /// Gates ONLY the net's subject statistics (internal builds), never a closure rule.
  static let STAT_ADMIT_MIN_EAR = 0.18

  /// [[cornerA, cornerB], iris, upper, lower, brow, sign]
  static let statEyes: [(Int, Int, Int, Int, Int, Int, Double)] = [
    (33, 133, 468, 159, 145, 105, 1.0),
    (263, 362, 473, 386, 374, 334, -1.0),
  ]

  /// Eye-centred, interocular-normalised weak-3D cloud; nil when degenerate.
  static func weak3dCloud(_ lm: [Double], _ width: Double, _ height: Double) -> [Double]? {
    let ratio = height / width
    let r = Landmarks.outerCorners.0, l = Landmarks.outerCorners.1
    let cx = 0.5 * (lm[r * 3] + lm[l * 3])
    let cy = 0.5 * (lm[r * 3 + 1] * ratio + lm[l * 3 + 1] * ratio)
    let cz = 0.5 * (lm[r * 3 + 2] + lm[l * 3 + 2])
    var out = [Double](repeating: 0, count: Landmarks.floats)
    for i in 0..<Landmarks.count {
      out[i * 3] = lm[i * 3] - cx
      out[i * 3 + 1] = lm[i * 3 + 1] * ratio - cy
      out[i * 3 + 2] = lm[i * 3 + 2] - cz
    }
    let scale = hypot(out[r * 3] - out[l * 3], out[r * 3 + 1] - out[l * 3 + 1])
    if !scale.isFinite || scale < 1e-8 { return nil }
    for i in 0..<out.count { out[i] /= scale }
    return out
  }

  /// [ray_x, ray_y, iod / focal]; nil when degenerate.
  static func cameraContext(_ lm: [Double], _ width: Double, _ height: Double, _ focalScale: Double) -> [Double]? {
    if !focalScale.isFinite || focalScale <= 0 { return nil }
    let ratio = height / width
    let r = Landmarks.outerCorners.0, l = Landmarks.outerCorners.1
    let rx = lm[r * 3], ry = lm[r * 3 + 1] * ratio, lx = lm[l * 3], ly = lm[l * 3 + 1] * ratio
    let center = (0.5 * (rx + lx), 0.5 * (ry + ly))
    let iod = hypot(rx - lx, ry - ly)
    if !iod.isFinite || iod < 1e-8 { return nil }
    return [(center.0 - 0.5) / focalScale, (center.1 - 0.5 * ratio) / focalScale, iod / focalScale]
  }

  static func landmarkValidity(_ lm: [Double]) -> [Float] {
    var out = [Float](repeating: 0, count: Landmarks.count)
    for i in 0..<Landmarks.count { out[i] = Landmarks.inFrame(lm, i) ? 1 : 0 }
    return out
  }

  static func rowStatistics(_ c: [Double]) -> [Double]? {
    var out = [Double](repeating: 0, count: 4)
    for (a, b, iris, upper, lower, brow, sign) in statEyes {
      let centreX = 0.5 * (c[a * 3] + c[b * 3]), centreY = 0.5 * (c[a * 3 + 1] + c[b * 3 + 1])
      var ux = c[b * 3] - c[a * 3], uy = c[b * 3 + 1] - c[a * 3 + 1]
      let width = hypot(ux, uy)
      if !width.isFinite || width < 1e-8 { return nil }
      ux /= width
      uy /= width
      let vx = -uy, vy = ux
      func alongV(_ i: Int) -> Double { return (((c[i * 3] - centreX) * vx + (c[i * 3 + 1] - centreY) * vy) / width) * sign }
      let up = alongV(upper), lo = alongV(lower), ir = alongV(iris), br = alongV(brow)
      out[0] += abs(up - lo)
      out[1] += ir - 0.5 * (up + lo)
      out[2] += up
      out[3] += br
    }
    for k in 0..<4 { out[k] *= 0.5 }
    return out
  }
}

/// numpy's pairwise summation (bit-comparable with the reference).
func dmsPairwiseSum(_ a: [Double], _ off: Int, _ n: Int) -> Double {
  if n < 8 {
    var res = 0.0
    for i in 0..<n { res += a[off + i] }
    return res
  }
  if n <= 128 {
    var r = Array(a[off..<(off + 8)])
    var i = 8
    let lim = n - (n % 8)
    while i < lim {
      for k in 0..<8 { r[k] += a[off + i + k] }
      i += 8
    }
    var res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]))
    while i < n { res += a[off + i]; i += 1 }
    return res
  }
  var n2 = n / 2
  n2 -= n2 % 8
  return dmsPairwiseSum(a, off, n2) + dmsPairwiseSum(a, off + n2, n - n2)
}

func dmsRoundHalfEven(_ x: Double) -> Double {
  let f = floor(x), diff = x - f
  if diff > 0.5 { return f + 1 }
  if diff < 0.5 { return f }
  return f.truncatingRemainder(dividingBy: 2) == 0 ? f : f + 1
}

final class DecayingHistogram1D {
  let lo: Double, hi: Double, bin: Double, n: Int, tau: Double
  private var counts: [Double]
  private var scale = 1.0
  private var tLast: Double? = nil
  private var sum = 0.0
  private var dirty = false

  init(lo: Double, hi: Double, binWidth: Double, tauS: Double) {
    self.lo = lo
    self.hi = hi
    self.bin = binWidth
    self.n = max(1, Int(dmsRoundHalfEven((hi - lo) / binWidth)))
    self.tau = tauS
    self.counts = [Double](repeating: 0, count: n)
  }

  func reset() {
    for i in 0..<n { counts[i] = 0 }
    scale = 1.0
    tLast = nil
    sum = 0
    dirty = false
  }

  private func rawSum() -> Double {
    if dirty { sum = dmsPairwiseSum(counts, 0, n); dirty = false }
    return sum
  }

  private func advance(_ t: Double) {
    if let last = tLast, tau > 0 {
      let dt = max(0.0, t - last)
      scale *= exp(-dt / tau)
      if scale < 1e-3 {
        for i in 0..<n { counts[i] *= scale }
        scale = 1.0
        dirty = true
      }
    }
    tLast = t
  }

  func add(_ x: Double, _ t: Double, _ w: Double = 1.0) {
    advance(t)
    if !x.isFinite || w <= 0 { return }
    var i = Int(((x - lo) / bin).rounded(.towardZero))
    i = min(max(i, 0), n - 1)
    counts[i] += w / scale
    dirty = true
  }

  func quantile(_ q: Double) -> Double? {
    let total = rawSum()
    if total <= 0 { return nil }
    let target = min(max(q, 0), 1) * total
    var acc = 0.0
    for i in 0..<n {
      acc += counts[i]
      if acc >= target {
        let prev = acc - counts[i]
        let frac = counts[i] > 0 ? (target - prev) / counts[i] : 0.5
        return lo + (Double(i) + frac) * bin
      }
    }
    return hi
  }
}

final class SubjectStatisticTracker {
  private let defaults: [Double]
  private let warmup: Int
  private let hists: [DecayingHistogram1D]
  private var count = 0

  init(trainingMean: [Double] = GazeInputs.TRAINING_MEAN, warmup: Int = GazeInputs.STAT_WARMUP_FRAMES,
       windowS: Double = GazeInputs.STAT_WINDOW_S) {
    defaults = trainingMean
    self.warmup = warmup
    hists = (0..<4).map { k in
      DecayingHistogram1D(lo: trainingMean[k] + GazeInputs.STAT_HIST_LO * 4.0,
                          hi: trainingMean[k] + GazeInputs.STAT_HIST_HI * 4.0,
                          binWidth: GazeInputs.STAT_HIST_BIN, tauS: windowS)
    }
  }

  func reset() {
    for h in hists { h.reset() }
    count = 0
  }

  @discardableResult
  func push(_ stats: [Double], _ t: Double) -> [Double] {
    if stats.allSatisfy({ $0.isFinite }) {
      for k in 0..<4 { hists[k].add(stats[k], t) }
      count += 1
    }
    return current()
  }

  func current() -> [Double] {
    var out = defaults
    if count < warmup { return out }
    for k in 0..<4 { if let m = hists[k].quantile(0.5) { out[k] = m } }
    return out
  }
}

/// The per-session assembler: `prepare` uses the tracker state BEFORE the frame; `admit` adds this
/// frame's statistics only for two open, unclipped eyes.
final class GazeInputAssembler {
  let tracker = SubjectStatisticTracker()

  func reset() { tracker.reset() }

  /// (cloud 1434, context 7, validity 478) as Float, plus the Double cloud for `admit`; nil when degenerate.
  func prepare(_ upright: [Double], _ width: Double, _ height: Double, _ focalScale: Double)
    -> (cloud: [Float], context: [Float], validity: [Float], cloud64: [Double])? {
    guard let cloud64 = GazeInputs.weak3dCloud(upright, width, height),
          let ctx3 = GazeInputs.cameraContext(upright, width, height, focalScale) else { return nil }
    let stats = tracker.current()
    let context = (ctx3 + stats).map { Float($0) }
    return (cloud64.map { Float($0) }, context, GazeInputs.landmarkValidity(upright), cloud64)
  }

  @discardableResult
  func admit(_ cloud64: [Double], _ tSec: Double, earR: Double, earL: Double, clippedR: Bool, clippedL: Bool) -> Bool {
    if clippedR || clippedL || !earR.isFinite || !earL.isFinite { return false }
    if 0.5 * (earR + earL) < GazeInputs.STAT_ADMIT_MIN_EAR { return false }
    guard let stats = GazeInputs.rowStatistics(cloud64), stats.allSatisfy({ $0.isFinite }) else { return false }
    tracker.push(stats, tSec)
    return true
  }
}
