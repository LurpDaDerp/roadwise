// `detect` self-test vectors (plan §3.3): one row of the drive detector's decision table
// (`src/detect/vectors.ts`), run through the PRODUCTION policy (`DetectPolicy`), never a copy, and
// answered as the row's `actual`. JS diffs it (`diffDetectSelfTest`). Foundation only.
import Foundation

enum DetectSelfTest {
  /// One vector's result: `{ name, kind: "detect", actual }`, or an `error` for a malformed row.
  static func result(_ name: String, _ inputs: Any?) -> [String: Any] {
    guard let v = inputs as? [String: Any], let kind = v["kind"] as? String else {
      return ["name": name, "kind": "detect", "error": "the row's inputs are missing"]
    }
    guard let actual = run(kind, v) else {
      return ["name": name, "kind": "detect", "error": "a malformed \(kind) row"]
    }
    return ["name": name, "kind": "detect", "actual": actual]
  }

  private static func run(_ kind: String, _ v: [String: Any]) -> [String: Any]? {
    switch kind {
    case "confirm":
      guard let trigger = v["trigger"] as? String, let rows = rowsOf(v["rows"]) else { return nil }
      let veto = (v["veto"] as? [Any])?.map { jsonBool($0) ?? false } ?? []
      let hit = confirm(trigger, rows, veto)
      return ["confirmedAt": opt(hit?.confirmedAt), "runStartTs": opt(hit?.runStartTs)]
    case "trace":
      guard let rows = rowsOf(v["rows"]), let h = jsonNumber(v["h"]) else { return nil }
      return ["index": opt(DetectPolicy.traceStart(rows, Int(h)).map { Double($0) })]
    case "start":
      return start(v)
    case "summary":
      guard let list = v["activities"] as? [Any], let now = jsonNumber(v["now"]) else { return nil }
      let acts = list.compactMap { activityOf($0) }
      guard acts.count == list.count else { return nil }
      return ["summary": motionJSON(DetectPolicy.summarize(acts, now))]
    case "motionGate":
      guard let m = motionOf(v["summary"]), let now = jsonNumber(v["now"]) else { return nil }
      return ["reason": DetectPolicy.motionGate(m, now)]
    case "wake":
      guard let c = wakeOf(v["ctx"]) else { return nil }
      return ["reason": DetectPolicy.wakeGate(c)]
    case "candidate":
      guard let trigger = v["trigger"] as? String, let since = jsonNumber(v["since"]), let now = jsonNumber(v["now"]) else { return nil }
      let cause = DetectPolicy.candidateDue(trigger, since: since, waitUntil: jsonNumber(v["waitUntil"]), walkSince: jsonNumber(v["walkSince"]), now: now)
      return ["cause": cause.map { $0 as Any } ?? NSNull()]
    case "end":
      return end(v)
    case "suppress":
      guard let since = jsonNumber(v["since"]), let until = jsonNumber(v["until"]), let now = jsonNumber(v["now"]) else { return nil }
      let cause = DetectPolicy.suppressionDue(since: since, until: until, lastOverStopTs: jsonNumber(v["lastOverStopTs"]), walkSince: jsonNumber(v["walkSince"]), now: now)
      return ["cause": cause.map { $0 as Any } ?? NSNull()]
    case "resume":
      guard let startedAt = jsonNumber(v["startedAt"]), let now = jsonNumber(v["now"]) else { return nil }
      return ["decision": DetectPolicy.resumeDecision(lastRowTs: jsonNumber(v["lastRowTs"]), startedAt: startedAt, now: now)]
    case "status":
      guard let p = statusInputsOf(v["inputs"]) else { return nil }
      let s = DetectPolicy.statusOf(p)
      return ["status": s.status, "missing": s.missing]
    default:
      return nil
    }
  }

  /// The confirmation over `rows`: the confirming row's index, its run's start and its time.
  private static func confirm(_ trigger: String, _ rows: [DetectRow], _ veto: [Bool]) -> (c: Int, runStartTs: Double, confirmedAt: Double)? {
    var s = ConfirmState()
    for (i, r) in rows.enumerated() {
      let step = DetectPolicy.confirmStep(s, r, trigger, veto: i < veto.count && veto[i])
      s = step.state
      if step.confirmed, let run = s.runStartTs { return (i, run, r.ts) }
    }
    return nil
  }

  private static func start(_ v: [String: Any]) -> [String: Any]? {
    guard let trigger = v["trigger"] as? String, let rows = rowsOf(v["rows"]), let since = jsonNumber(v["automotiveSince"]) else { return nil }
    let lastEnd = lastEndOf(v["lastEnd"])
    guard let hit = confirm(trigger, rows, []) else { return ["confirmedAt": NSNull(), "start": NSNull()] }
    let buffer = Array(rows[0...hit.c])
    let h = buffer.firstIndex { $0.ts == hit.runStartTs } ?? 0
    let s = DetectPolicy.startOf(buffer, h, trigger, since, lastEnd)
    let start: [String: Any] = [
      "index": s.index,
      "startedAt": s.startedAt,
      "startSource": s.startSource,
      "startLat": opt(s.startLat),
      "startLng": opt(s.startLng),
      "continues": DetectPolicy.continuesFrom(lastEnd, s.startedAt, s.startLat, s.startLng),
    ]
    return ["confirmedAt": hit.confirmedAt, "start": start]
  }

  private static func end(_ v: [String: Any]) -> [String: Any]? {
    guard let startedAt = jsonNumber(v["startedAt"]), let steps = v["steps"] as? [Any] else { return nil }
    var clock = DetectPolicy.endClockAt(startedAt)
    var results: [[String: Any]] = []
    for raw in steps {
      guard let step = raw as? [String: Any] else { return nil }
      if step["row"] != nil {
        guard let r = rowOf(step["row"]) else { return nil }
        clock = DetectPolicy.endOnRow(clock, r, automotiveNow: jsonBool(step["automotive"]) ?? false)
      } else {
        guard let now = jsonNumber(step["check"]) else { return nil }
        let d = DetectPolicy.endDue(clock, startedAt: startedAt, now: now, walkSince: jsonNumber(step["walkSince"]))
        results.append(["due": d.due.map { $0 as Any } ?? NSNull(), "overdue": d.overdue.map { $0 as Any } ?? NSNull()])
      }
    }
    return ["results": results]
  }

  // MARK: - Reading the row's JSON

  private static func opt(_ x: Double?) -> Any { x.map { $0 as Any } ?? NSNull() }

  private static func rowOf(_ any: Any?) -> DetectRow? { DetectRow(json: any) }

  private static func rowsOf(_ any: Any?) -> [DetectRow]? {
    guard let list = any as? [Any] else { return nil }
    let rows = list.compactMap { rowOf($0) }
    return rows.count == list.count ? rows : nil
  }

  private static func lastEndOf(_ any: Any?) -> DetectLastEnd? {
    guard let o = any as? [String: Any], let decidedAt = jsonNumber(o["decidedAt"]), let cut = jsonNumber(o["cut"]),
          let lat = jsonNumber(o["lat"]), let lng = jsonNumber(o["lng"]), let id = o["driveId"] as? String else { return nil }
    return DetectLastEnd(decidedAt: decidedAt, cut: cut, lat: lat, lng: lng, driveId: id)
  }

  private static func activityOf(_ any: Any) -> DetectActivity? {
    guard let o = any as? [String: Any], let start = jsonNumber(o["start"]), let automotive = jsonBool(o["automotive"]),
          let stationary = jsonBool(o["stationary"]), let onFoot = jsonBool(o["onFoot"]), let confident = jsonBool(o["confident"]) else { return nil }
    return DetectActivity(start: start, automotive: automotive, stationary: stationary, onFoot: onFoot, confident: confident)
  }

  private static func motionOf(_ any: Any?) -> DetectMotion? {
    guard let o = any as? [String: Any], let last = jsonNumber(o["lastAutomotiveAt"]), let since = jsonNumber(o["automotiveSince"]),
          let onFoot = jsonBool(o["onFootNow"]) else { return nil }
    return DetectMotion(lastAutomotiveAt: last, automotiveSince: since, onFootNow: onFoot)
  }

  private static func motionJSON(_ m: DetectMotion) -> [String: Any] {
    ["lastAutomotiveAt": m.lastAutomotiveAt, "automotiveSince": m.automotiveSince, "onFootNow": m.onFootNow]
  }

  private static func wakeOf(_ any: Any?) -> WakeCtx? {
    guard let o = any as? [String: Any], let now = jsonNumber(o["now"]), let reason = o["reason"] as? String, let phase = o["phase"] as? String,
          let armed = jsonBool(o["armed"]), let hasOwner = jsonBool(o["hasOwner"]), let ok = jsonBool(o["permissionsOk"]),
          let rest = jsonNumber(o["candidateRestUntil"]), let starts = o["candidateStarts"] as? [Any] else { return nil }
    let times = starts.compactMap { jsonNumber($0) }
    guard times.count == starts.count else { return nil }
    return WakeCtx(now: now, reason: reason, phase: phase, armed: armed, hasOwner: hasOwner, permissionsOk: ok, candidateRestUntil: rest, candidateStarts: times)
  }

  private static func statusInputsOf(_ any: Any?) -> StatusInputs? {
    guard let o = any as? [String: Any], let armed = jsonBool(o["armed"]), let hardware = jsonBool(o["hardware"]),
          let location = o["location"] as? String, let precise = jsonBool(o["precise"]), let motion = o["motion"] as? String,
          let refresh = o["backgroundRefresh"] as? String, let live = jsonBool(o["liveActivities"]) else { return nil }
    return StatusInputs(armed: armed, hardware: hardware, location: location, precise: precise, motion: motion, backgroundRefresh: refresh, liveActivities: live)
  }
}
