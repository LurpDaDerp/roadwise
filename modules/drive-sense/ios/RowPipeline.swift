// The capture's work queue: 25 Hz samples and fixes in, one FeatureRow per window out.
//
// Rows close on the capture's 1 s tick with `ts` = the tick's wall-clock instant, rounded (README
// §7 "Windows"). A row's window is (previous row's ts, ts]; its IMU samples are those stamped in
// it and its fix is the one with the latest fix timestamp in it. A row is computed once the data
// for its window can be complete: a sample stamped after `ts` has arrived (or the IMU is not
// running) AND a fix stamped after `ts` has arrived or FIX_SETTLE_MS has passed (Core Location
// delivers a fix a few hundred ms after its timestamp) — and in any case ROW_MAX_WAIT_MS after
// `ts`, the README's Android bound. At `low` rate a row is emitted per fix instead, with the IMU
// absent. Everything here runs on `queue` only.
import Foundation

final class RowPipeline {
  static let FIX_SETTLE_MS: Double = 300
  static let ROW_MAX_WAIT_MS: Double = 1500
  /// Ten seconds of 25 Hz samples; older ones can only belong to closed windows.
  static let IMU_BUFFER_MAX: Int = 250
  static let FIX_BUFFER_MAX: Int = 30

  let queue = DispatchQueue(label: "drivesense.capture", qos: .userInitiated)
  /// Called on `queue` with each row and the capture generation it belongs to.
  var onRow: ((ExtractedRow, Int) -> Void)?

  private var generation = 0
  private var extractor = FeatureExtractor()
  private var imu: [ImuSample] = []
  private var fixes: [FixSample] = []
  private var pending: [(ts: Double, phone: PhoneSample)] = []
  private var prevRowTs: Double?
  private var latestImuT = -Double.infinity
  private var latestFixT = -Double.infinity
  private var imuExpected = false
  /// Diagnostics: samples and fixes that arrived after their window had closed; rows dropped for
  /// a non-finite value (never expected: the extractor cannot produce one from finite input).
  private(set) var droppedSamples = 0
  private(set) var droppedFixes = 0
  private(set) var droppedRows = 0

  /// A new capture (or its end): fresh extractor state, empty buffers, first-window rule again.
  func reset(generation: Int) {
    self.generation = generation
    extractor = FeatureExtractor()
    imu.removeAll()
    fixes.removeAll()
    pending.removeAll()
    prevRowTs = nil
    latestImuT = -Double.infinity
    latestFixT = -Double.infinity
    imuExpected = false
  }

  func setImuExpected(_ expected: Bool) {
    imuExpected = expected
    if !expected { imu.removeAll() }
    check()
  }

  func addSample(_ s: ImuSample) {
    imu.append(s)
    if imu.count > Self.IMU_BUFFER_MAX { imu.removeFirst(imu.count - Self.IMU_BUFFER_MAX) }
    if s.t > latestImuT { latestImuT = s.t }
    check()
  }

  func addFix(_ f: FixSample) {
    fixes.append(f)
    if fixes.count > Self.FIX_BUFFER_MAX { fixes.removeFirst(fixes.count - Self.FIX_BUFFER_MAX) }
    if f.t > latestFixT { latestFixT = f.t }
    check()
  }

  /// The 1 s tick: queue the row closing at `ts` with the phone state read at the tick.
  func tick(ts: Double, phone: PhoneSample, generation gen: Int) {
    guard gen == generation else { return }
    let last = pending.last?.ts ?? prevRowTs ?? -Double.infinity
    guard ts > last else { return } // strictly increasing (a wall clock set back waits it out)
    pending.append((ts, phone))
    for wait in [Self.FIX_SETTLE_MS, Self.ROW_MAX_WAIT_MS] {
      let delay = Swift.max(0, (ts + wait - TimeBase.nowEpochMs()) / 1000) + 0.005
      queue.asyncAfter(deadline: .now() + delay) { [weak self] in
        guard let self = self, gen == self.generation else { return }
        self.check()
      }
    }
    check()
  }

  /// Close every queued row now (the rate is dropping to `low`).
  func flush() {
    while !pending.isEmpty { close(pending.removeFirst()) }
  }

  /// `low` rate: one IMU-absent row per fix, `ts` = the fix's time rounded, skipped unless it is
  /// later than the previous row.
  func lowRateFix(_ fix: FixSample, phone: PhoneSample, generation gen: Int) {
    guard gen == generation else { return }
    let ts = jsRound(fix.t)
    guard ts > (prevRowTs ?? -Double.infinity) else { return }
    prevRowTs = ts
    fixes.removeAll()
    deliver(extractor.extractSecond(imu: [], fix: fix, phone: phone, tsMs: ts))
  }

  private func check() {
    let now = TimeBase.nowEpochMs()
    while let p = pending.first {
      let imuReady = !imuExpected || latestImuT > p.ts
      let fixReady = latestFixT > p.ts || now >= p.ts + Self.FIX_SETTLE_MS
      guard (imuReady && fixReady) || now >= p.ts + Self.ROW_MAX_WAIT_MS else { return }
      pending.removeFirst()
      close(p)
    }
  }

  private func close(_ p: (ts: Double, phone: PhoneSample)) {
    let start = TimeBase.windowStart(prevTs: prevRowTs, ts: p.ts)
    let w = TimeBase.takeWindow(imu, start: start, ts: p.ts)
    imu = w.rest
    droppedSamples += w.dropped
    let fix = TimeBase.pickFix(fixes, start: start, ts: p.ts)
    // Fixes in the window are used (the latest) or superseded; those at or before its start
    // arrived after their own window closed. Only later fixes wait.
    droppedFixes += fixes.filter { $0.t <= start }.count
    fixes = fixes.filter { $0.t > p.ts }
    prevRowTs = p.ts
    deliver(extractor.extractSecond(imu: w.inWindow, fix: fix, phone: p.phone, tsMs: p.ts))
  }

  private func deliver(_ row: ExtractedRow) {
    guard row.firstNonFiniteField == nil else {
      droppedRows += 1
      return
    }
    onRow?(row, generation)
  }
}
