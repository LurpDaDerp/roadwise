// The drive detector's confirmation and start (plan §3.3): the Swift mirror of that half of
// `src/detect/policy.ts`, rule for rule and in the same order of operations, so the shared decision
// table (`src/detect/vectors.ts`) answers the same here (`DetectSelfTest`). Pure: Foundation only.
import Foundation

extension DetectPolicy {
  /// policy.ts `EVIDENCE_EPS`: the evidence is a float sum, which may land a hair under 1.
  private static let evidenceEps: Double = 0.000000001

  // MARK: - Confirmation

  /// policy.ts `autoHoldMs`: the hold (ms) a speed (m/s) needs on its own, (5/3)·(30 − mph) s: the
  /// line from `AUTO_HOLD_MS_15` at 15 mph down to 0 at `AUTO_INSTANT_MPS` (30 mph), never under
  /// `AUTO_HOLD_MIN_MS` (the GPS-spike guard: at 30 mph and over a drive confirms on the second good
  /// reading in a row, never on one); infinite at 15 mph and under.
  static func autoHoldMs(_ mps: Double) -> Double {
    if !(mps > AUTO_MIN_MPS) { return Double.infinity }
    return max(AUTO_HOLD_MIN_MS, AUTO_HOLD_MS_15 * (AUTO_INSTANT_MPS - mps) / (AUTO_INSTANT_MPS - AUTO_MIN_MPS))
  }

  /// policy.ts `autoStep`: a trusted row over 15 mph earns at 1 / hold per ms (not when vetoed,
  /// nor under 20 mph without fresh car motion); the interval between two earning rows at most 2 s
  /// apart adds its length at the slower one's rate; 5 min with no trusted row over 3 mph forgets it
  /// all; it confirms at 1.
  static func autoStep(_ s: ConfirmState, _ r: DetectRow, veto: Bool, carFresh: Bool) -> (state: ConfirmState, confirmed: Bool) {
    let ok = trusted(r)
    let earns = ok && !veto && r.speed > AUTO_MIN_MPS && (r.speed >= AUTO_MPS_20 || carFresh)
    let rate: Double = earns ? 1 / autoHoldMs(r.speed) : 0
    var e = s.evidence
    var first = s.runStartTs
    if let p = s.prevTs, rate > 0, s.prevRate > 0, r.ts - p > 0, r.ts - p <= AUTO_ROW_GAP_MAX_MS {
      e += (r.ts - p) * min(rate, s.prevRate)
      if first == nil { first = p }
    }
    let lastMove: Double? = ok && r.speed > STOP_MPS ? r.ts : s.lastMoveTs
    if e > 0, let m = lastMove, r.ts - m >= AUTO_FORGET_MS {
      e = 0
      first = nil
    }
    let state = ConfirmState(runStartTs: first, dipStartTs: nil, evidence: e, prevTs: r.ts, prevRate: rate, lastMoveTs: lastMove)
    return (state, e >= 1 - evidenceEps && !veto)
  }

  /// policy.ts `confirmStep`: auto, the evidence (`autoStep`); the Start card, a fast row extends
  /// the run and confirms once it spans the hold (unless vetoed), a slow or untrusted row starts or
  /// extends a dip, which breaks the run past 5 s.
  static func confirmStep(_ s: ConfirmState, _ r: DetectRow, _ kind: String, veto: Bool = false, carFresh: Bool = false) -> (state: ConfirmState, confirmed: Bool) {
    if kind == "auto" { return autoStep(s, r, veto: veto, carFresh: carFresh) }
    if trusted(r) && r.speed >= CONFIRM_MPS_MANUAL {
      let run = s.runStartTs ?? r.ts
      return (ConfirmState(runStartTs: run, dipStartTs: nil), r.ts - run >= CONFIRM_HOLD_MS_MANUAL && !veto)
    }
    guard let run = s.runStartTs else { return (ConfirmState(), false) }
    let dip = s.dipStartTs ?? r.ts
    if r.ts - dip > CONFIRM_DIP_MAX_MS { return (ConfirmState(), false) }
    return (ConfirmState(runStartTs: run, dipStartTs: dip), false)
  }

  // MARK: - The start

  /// policy.ts `traceStart`: the last trusted row at or under 3 mph before the run, going on back
  /// past a stop shorter than 5 min that had the car rolling (5 mph or more) before it. Nil when the
  /// rows begin moving.
  static func traceStart(_ rows: [DetectRow], _ h: Int) -> Int? {
    var k = min(max(h, 0), rows.count)
    // k falls on every pass, so this ends within rows.count + 1 passes.
    for _ in 0...rows.count {
      guard let s = (0..<k).reversed().first(where: { slow(rows[$0]) }) else { return nil }
      guard let j = (0..<s).reversed().first(where: { rolling(rows[$0]) }) else { return s }
      if rows[s].ts - rows[j].ts >= TRACE_STOP_SPLIT_MS { return s }
      k = j
    }
    return nil
  }

  /// policy.ts `startOf`: the traced start, else (auto only) the car motion's start placed at the
  /// last end when reachable, else the first row. `rows` is never empty.
  static func startOf(_ rows: [DetectRow], _ h: Int, _ kind: String, _ automotiveSince: Double, _ lastEnd: DetectLastEnd?) -> TracedStart {
    if let s = traceStart(rows, h) {
      let r = rows[s]
      return TracedStart(index: s, startedAt: r.ts, startSource: "trace", startLat: r.lat, startLng: r.lng)
    }
    let first = rows[0]
    if kind == "auto" && automotiveSince > 0 && automotiveSince < first.ts {
      var plausible = false
      if let e = lastEnd, let ref = rows.first(where: { trusted($0) }) {
        plausible = distanceM(e.lat, e.lng, ref.lat, ref.lng) <= PLAUSIBLE_MPS_MAX * (ref.ts - automotiveSince) / 1000 + PLAUSIBLE_SLACK_M
      }
      return TracedStart(index: 0, startedAt: automotiveSince, startSource: "motion", startLat: plausible ? lastEnd?.lat : nil, startLng: plausible ? lastEnd?.lng : nil)
    }
    let ok = trusted(first)
    return TracedStart(index: 0, startedAt: first.ts, startSource: "wake", startLat: ok ? first.lat : nil, startLng: ok ? first.lng : nil)
  }

  /// policy.ts `continuesFrom`: within 5 min of the last end's decision and 150 m of its place.
  static func continuesFrom(_ e: DetectLastEnd?, _ startedAt: Double, _ lat: Double?, _ lng: Double?) -> Bool {
    guard let e = e, let lat = lat, let lng = lng else { return false }
    return startedAt - e.decidedAt <= CONTINUE_GAP_MS && distanceM(e.lat, e.lng, lat, lng) <= CONTINUE_DIST_M
  }
}
