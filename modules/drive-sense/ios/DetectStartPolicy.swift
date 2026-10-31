// The drive detector's confirmation and start (plan §3.3): the Swift mirror of that half of
// `src/detect/policy.ts`, rule for rule and in the same order of operations, so the shared decision
// table (`src/detect/vectors.ts`) answers the same here (`DetectSelfTest`). Pure: Foundation only.
import Foundation

/// The slow-traffic path's accumulators for one candidate (policy.ts `SlowTrafficState`): car motion
/// banked and the standing car report's arrival; on foot since the candidate opened; the first and
/// last trusted fix and the path between; the sum and count of trusted rows over 3 mph; the first
/// trusted row at 5 mph or more (the trace-back's start) and the last trusted row over 3 mph.
struct SlowTrafficState: Equatable {
  var carMs: Double = 0
  var carSince: Double?
  var onFoot = false
  var firstLat: Double?
  var firstLng: Double?
  var lastTs: Double?
  var lastLat: Double = 0
  var lastLng: Double = 0
  var pathM: Double = 0
  var sumMps: Double = 0
  var movingRows = 0
  var runStartTs: Double?
  var lastMoveTs: Double?
}

/// The car link start in progress (policy.ts `LinkState`): the run of link rows, its start, the last one's time.
struct LinkState: Equatable {
  var run = 0
  var runStartTs: Double?
  var prevTs: Double?
}

/// One Bluetooth or CarPlay output of the audio route: its uid (what a pairing matches; a renamed car
/// keeps it), its name as the phone shows it now, and its port ("bluetoothA2DP", "bluetoothHFP",
/// "bluetoothLE" or "carAudio", which is CarPlay).
struct CarOutput: Codable, Equatable {
  var uid: String
  var name: String
  var type: String
}

extension DetectPolicy {
  /// policy.ts `EVIDENCE_EPS`: the evidence is a float sum, which may land a hair under 1.
  private static let evidenceEps: Double = 0.000000001

  // MARK: - Confirmation

  /// policy.ts `autoHoldMs`: the hold (ms) a speed (m/s) needs on its own, (5/3)·(30 − mph) s: the
  /// line from `AUTO_HOLD_MS_15` at 15 mph down to 0 at `AUTO_INSTANT_MPS` (30 mph), never under
  /// `AUTO_HOLD_MIN_MS` (the GPS-spike guard, a little under the 1 s row interval: at 30 mph and over
  /// a drive confirms on the second good reading in a row despite timer jitter, never on one);
  /// infinite at 15 mph and under.
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

  /// policy.ts `noteVeto`: one live report into the veto's memory. A low-confidence report changes
  /// nothing, and neither does a stationary or unknown one.
  static func noteVeto(_ s: VetoState, at: Double, onFoot: Bool, automotive: Bool, confident: Bool) -> VetoState {
    guard confident else { return s }
    return VetoState(onFootAt: onFoot ? at : s.onFootAt, automotiveAt: automotive ? at : s.automotiveAt)
  }

  /// policy.ts `onFootVeto`: a confident walking, running or cycling report that arrived in the last
  /// `VETO_FRESH_MS` holds an auto confirmation, unless a confident automotive report arrived after it.
  static func onFootVeto(_ s: VetoState, _ now: Double) -> Bool {
    guard let f = s.onFootAt, now - f <= VETO_FRESH_MS else { return false }
    guard let c = s.automotiveAt else { return true }
    return c <= f
  }

  // MARK: - Slow traffic (beside the speed evidence)

  /// policy.ts `slowTrafficCarMs`: the car motion banked plus the standing car report's stretch.
  static func slowTrafficCarMs(_ s: SlowTrafficState, _ now: Double) -> Double {
    guard let since = s.carSince, now > since else { return s.carMs }
    return s.carMs + (now - since)
  }

  /// policy.ts `slowTrafficHeld`: some car motion (the candidate then waits 5 min, not 3).
  static func slowTrafficHeld(_ s: SlowTrafficState, _ now: Double) -> Bool { slowTrafficCarMs(s, now) > 0 }

  /// policy.ts `slowTrafficReport`: the standing car motion is banked; a confident automotive report
  /// that is not stationary starts a new stretch; a confident on-foot report marks it for good.
  static func slowTrafficReport(_ s: SlowTrafficState, at: Double, automotive: Bool, stationary: Bool, onFoot: Bool, confident: Bool) -> SlowTrafficState {
    var n = s
    if let since = s.carSince, at > since { n.carMs = s.carMs + (at - since) }
    n.carSince = confident && automotive && !stationary ? at : nil
    if confident && onFoot { n.onFoot = true }
    return n
  }

  /// policy.ts `slowTrafficConfirmed`: never on foot; 90 s of car motion, an 800 m path, the last fix
  /// 400 m in a straight line from the first, an 8 mph average over the trusted rows over 3 mph.
  static func slowTrafficConfirmed(_ s: SlowTrafficState, _ now: Double) -> Bool {
    guard !s.onFoot, let fLat = s.firstLat, let fLng = s.firstLng, s.lastTs != nil, s.movingRows > 0 else { return false }
    return slowTrafficCarMs(s, now) >= SLOW_CAR_MS &&
      s.pathM >= SLOW_PATH_M &&
      distanceM(fLat, fLng, s.lastLat, s.lastLng) >= SLOW_NET_M &&
      s.sumMps / Double(s.movingRows) >= SLOW_AVG_MPS
  }

  /// policy.ts `slowTrafficStep`, in its order: 5 min with no trusted row over 3 mph forgets all but
  /// the on-foot mark (a standing car report starts again here); a trusted row over 3 mph adds the
  /// step from the last trusted fix when that is at most 2 s older, and its speed to the average.
  static func slowTrafficStep(_ s: SlowTrafficState, _ r: DetectRow) -> (state: SlowTrafficState, confirmed: Bool) {
    var n = s
    if let m = s.lastMoveTs, r.ts - m >= AUTO_FORGET_MS {
      n = SlowTrafficState()
      n.onFoot = s.onFoot
      n.carSince = s.carSince == nil ? nil : r.ts
    }
    let ok = trusted(r)
    let moved = ok && r.speed > STOP_MPS
    if moved, let t = n.lastTs, r.ts - t > 0, r.ts - t <= AUTO_ROW_GAP_MAX_MS {
      n.pathM += distanceM(n.lastLat, n.lastLng, r.lat, r.lng)
    }
    if ok && n.firstLat == nil {
      n.firstLat = r.lat
      n.firstLng = r.lng
    }
    if ok {
      n.lastTs = r.ts
      n.lastLat = r.lat
      n.lastLng = r.lng
    }
    if moved {
      n.sumMps += r.speed
      n.movingRows += 1
    }
    if n.runStartTs == nil && ok && r.speed >= MOVE_MPS { n.runStartTs = r.ts }
    if moved { n.lastMoveTs = r.ts }
    return (n, slowTrafficConfirmed(n, r.ts))
  }

  // MARK: - The car link

  /// policy.ts `carLinked`: any current output is a paired car (by uid) or CarPlay.
  static func carLinked(_ current: [CarOutput], paired: [String]) -> Bool {
    current.contains { $0.type == "carAudio" || paired.contains($0.uid) }
  }

  /// policy.ts `carMostOfDrive`: current for more than half the rows of a drive of 2 min or more.
  static func carMostOfDrive(_ withRows: Int, _ rows: Int) -> Bool {
    rows >= CAR_DRIVE_MIN_ROWS && Double(withRows) > Double(rows) * CAR_DRIVE_SHARE_MIN
  }

  /// policy.ts `linkStep`: with the link up, a trusted row at 5 mph or more, not vetoed, with fresh car
  /// motion or at 15 mph or more, extends the run when within 2 s of the last, else begins one; any
  /// other row ends it. Two in a row confirm.
  static func linkStep(_ s: LinkState, _ r: DetectRow, linked: Bool, veto: Bool, carFresh: Bool) -> (state: LinkState, confirmed: Bool) {
    let ok = linked && !veto && trusted(r) && r.speed >= LINK_MIN_MPS && (carFresh || r.speed >= LINK_NO_CAR_MPS)
    guard ok else { return (LinkState(), false) }
    var n = LinkState(run: 1, runStartTs: r.ts, prevTs: r.ts)
    if s.run > 0, let p = s.prevTs, r.ts - p > 0, r.ts - p <= AUTO_ROW_GAP_MAX_MS {
      n.run = s.run + 1
      n.runStartTs = s.runStartTs ?? r.ts
    }
    return (n, n.run >= LINK_PACE_ROWS)
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
