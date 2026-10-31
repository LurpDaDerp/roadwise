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
      let hit = confirm(trigger, rows, flags(v["veto"]), flags(v["car"]))
      return ["confirmedAt": opt(hit?.confirmedAt), "runStartTs": opt(hit?.runStartTs)]
    case "trace":
      guard let rows = rowsOf(v["rows"]), let h = jsonNumber(v["h"]) else { return nil }
      return ["index": opt(DetectPolicy.traceStart(rows, Int(h)).map { Double($0) })]
    case "start":
      return start(v)
    case "slow":
      return slow(v)
    case "link":
      guard let rows = rowsOf(v["rows"]) else { return nil }
      let link = flags(v["link"]), veto = flags(v["veto"]), car = flags(v["car"])
      var s = LinkState()
      for (i, r) in rows.enumerated() {
        let st = DetectPolicy.linkStep(s, r, linked: i < link.count && link[i], veto: i < veto.count && veto[i], carFresh: i < car.count && car[i])
        s = st.state
        if st.confirmed { return ["confirmedAt": r.ts, "runStartTs": opt(s.runStartTs)] }
      }
      return ["confirmedAt": NSNull(), "runStartTs": NSNull()]
    case "car":
      guard let list = v["current"] as? [Any], let pairedList = v["paired"] as? [Any], let withRows = jsonNumber(v["withRows"]),
            let rows = jsonNumber(v["rows"]) else { return nil }
      let current = list.compactMap { raw -> CarOutput? in
        guard let o = raw as? [String: Any], let uid = o["uid"] as? String, let type = o["type"] as? String else { return nil }
        return CarOutput(uid: uid, name: "", type: type)
      }
      let paired = pairedList.compactMap { $0 as? String }
      guard current.count == list.count, paired.count == pairedList.count else { return nil }
      return ["linked": DetectPolicy.carLinked(current, paired: paired), "most": DetectPolicy.carMostOfDrive(Int(withRows), Int(rows))]
    case "summary":
      guard let list = v["activities"] as? [Any], let now = jsonNumber(v["now"]) else { return nil }
      let acts = list.compactMap { activityOf($0) }
      guard acts.count == list.count else { return nil }
      return ["summary": motionJSON(DetectPolicy.summarize(acts, now))]
    case "motionGate":
      guard let m = motionOf(v["summary"]), let now = jsonNumber(v["now"]) else { return nil }
      return ["reason": DetectPolicy.motionGate(m, now)]
    case "veto":
      guard let list = v["reports"] as? [Any], let now = jsonNumber(v["now"]) else { return nil }
      var s = VetoState()
      for raw in list {
        guard let o = raw as? [String: Any], let at = jsonNumber(o["at"]), let onFoot = jsonBool(o["onFoot"]),
              let automotive = jsonBool(o["automotive"]), let confident = jsonBool(o["confident"]) else { return nil }
        s = DetectPolicy.noteVeto(s, at: at, onFoot: onFoot, automotive: automotive, confident: confident)
      }
      return ["vetoed": DetectPolicy.onFootVeto(s, now)]
    case "wake":
      guard let c = wakeOf(v["ctx"]) else { return nil }
      return ["reason": DetectPolicy.wakeGate(c)]
    case "candidate":
      guard let trigger = v["trigger"] as? String, let since = jsonNumber(v["since"]), let now = jsonNumber(v["now"]) else { return nil }
      let cause = DetectPolicy.candidateDue(trigger, since: since, waitUntil: jsonNumber(v["waitUntil"]), walkSince: jsonNumber(v["walkSince"]), now: now,
                                            lastVehicleTs: jsonNumber(v["lastVehicleTs"]), hasEvidence: jsonBool(v["hasEvidence"]) ?? false)
      return ["cause": cause.map { $0 as Any } ?? NSNull()]
    case "startsAfter":
      guard let list = v["starts"] as? [Any], let since = jsonNumber(v["since"]), let saw = jsonBool(v["sawVehicle"]) else { return nil }
      let starts = list.compactMap { jsonNumber($0) }
      guard starts.count == list.count else { return nil }
      return ["starts": DetectPolicy.startsAfter(starts, since: since, sawVehicle: saw)]
    case "end":
      return end(v)
    case "suppress":
      guard let since = jsonNumber(v["since"]), let until = jsonNumber(v["until"]), let now = jsonNumber(v["now"]) else { return nil }
      let cause = DetectPolicy.suppressionDue(since: since, until: until, lastOverStopTs: jsonNumber(v["lastOverStopTs"]), walkSince: jsonNumber(v["walkSince"]), now: now)
      return ["cause": cause.map { $0 as Any } ?? NSNull()]
    case "suppressResume":
      return suppressResume(v)
    case "resume":
      guard let startedAt = jsonNumber(v["startedAt"]), let now = jsonNumber(v["now"]) else { return nil }
      return ["decision": DetectPolicy.resumeDecision(lastRowTs: jsonNumber(v["lastRowTs"]), startedAt: startedAt, now: now)]
    case "resumeSeq":
      guard let top = jsonNumber(v["topSeq"]), top >= 0, top <= Double(Int32.max) else { return nil }
      return ["lastSeq": DetectPolicy.resumeSeq(Int(top))]
    case "status":
      guard let p = statusInputsOf(v["inputs"]) else { return nil }
      let s = DetectPolicy.statusOf(p)
      return ["status": s.status, "missing": s.missing]
    default:
      return nil
    }
  }

  /// A row's per-row flags (`veto`, `car`): missing or not a bool is false.
  private static func flags(_ value: Any?) -> [Bool] {
    (value as? [Any])?.map { jsonBool($0) ?? false } ?? []
  }

  /// The confirmation over `rows`: the confirming row's index, its run's start and its time.
  private static func confirm(_ trigger: String, _ rows: [DetectRow], _ veto: [Bool], _ car: [Bool]) -> (c: Int, runStartTs: Double, confirmedAt: Double)? {
    var s = ConfirmState()
    for (i, r) in rows.enumerated() {
      let step = DetectPolicy.confirmStep(s, r, trigger, veto: i < veto.count && veto[i], carFresh: i < car.count && car[i])
      s = step.state
      if step.confirmed, let run = s.runStartTs { return (i, run, r.ts) }
    }
    return nil
  }

  private static func start(_ v: [String: Any]) -> [String: Any]? {
    guard let trigger = v["trigger"] as? String, let rows = rowsOf(v["rows"]), let since = jsonNumber(v["automotiveSince"]) else { return nil }
    let lastEnd = lastEndOf(v["lastEnd"])
    guard let hit = confirm(trigger, rows, [], flags(v["car"])) else { return ["confirmedAt": NSNull(), "start": NSNull()] }
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

  /// The slow-traffic path over rows and live reports in arrival order: where it confirmed, its run's
  /// start, the trace-back from there over the rows so far, and the car motion banked by then.
  private static func slow(_ v: [String: Any]) -> [String: Any]? {
    guard let steps = v["steps"] as? [Any] else { return nil }
    var s = SlowTrafficState()
    var rows: [DetectRow] = []
    var last: Double = 0
    for raw in steps {
      guard let step = raw as? [String: Any] else { return nil }
      if let o = step["report"] as? [String: Any] {
        guard let at = jsonNumber(o["at"]), let automotive = jsonBool(o["automotive"]), let stationary = jsonBool(o["stationary"]),
              let onFoot = jsonBool(o["onFoot"]), let confident = jsonBool(o["confident"]) else { return nil }
        s = DetectPolicy.slowTrafficReport(s, at: at, automotive: automotive, stationary: stationary, onFoot: onFoot, confident: confident)
        last = at
        continue
      }
      guard let r = rowOf(step["row"]) else { return nil }
      rows.append(r)
      last = r.ts
      let st = DetectPolicy.slowTrafficStep(s, r)
      s = st.state
      if st.confirmed {
        let h = rows.firstIndex { $0.ts == s.runStartTs } ?? 0
        let traced = DetectPolicy.traceStart(rows, h).map { Double($0) }
        return ["confirmedAt": r.ts, "runStartTs": opt(s.runStartTs), "traced": opt(traced), "carMs": DetectPolicy.slowTrafficCarMs(s, r.ts)]
      }
    }
    return ["confirmedAt": NSNull(), "runStartTs": NSNull(), "traced": NSNull(), "carMs": DetectPolicy.slowTrafficCarMs(s, last)]
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
        if let n = jsonNumber(step["steps"]) { clock = DetectPolicy.endOnSteps(clock, ts: r.ts, steps: Int(n)) }
      } else {
        guard let now = jsonNumber(step["check"]) else { return nil }
        let walkSince = jsonNumber(step["walkSince"])
        let waitUntil = jsonNumber(step["waitUntil"])
        let gone = jsonNumber(step["carGoneSince"])
        let d = DetectPolicy.endDue(clock, startedAt: startedAt, now: now, walkSince: walkSince, waitUntil: waitUntil, carGoneSince: gone)
        let linger = DetectPolicy.lingerAfterJsEnd(clock, startedAt: startedAt, now: now, walkSince: walkSince, waitUntil: waitUntil, carGoneSince: gone)
        results.append(["due": d.due.map { $0 as Any } ?? NSNull(), "overdue": d.overdue.map { $0 as Any } ?? NSNull(), "linger": linger])
      }
    }
    return ["results": results]
  }

  /// A relaunch mid-rest, then the rest's clock at each check (nothing over 3 mph, no walk).
  private static func suppressResume(_ v: [String: Any]) -> [String: Any]? {
    guard let since = jsonNumber(v["since"]), let until = jsonNumber(v["until"]), let relaunch = jsonNumber(v["relaunch"]),
          let list = v["checks"] as? [Any] else { return nil }
    let checks = list.compactMap { jsonNumber($0) }
    guard checks.count == list.count else { return nil }
    guard let moved = DetectPolicy.suppressionResume(until: until, now: relaunch) else {
      return ["resumed": false, "causes": [Any]()]
    }
    let causes: [Any] = checks.map { t -> Any in
      DetectPolicy.suppressionDue(since: since, until: until, lastOverStopTs: moved, walkSince: nil, now: t).map { $0 as Any } ?? NSNull()
    }
    return ["resumed": true, "causes": causes]
  }

  // MARK: - Reading the row's JSON

  private static func opt(_ x: Double?) -> Any { x.map { $0 as Any } ?? NSNull() }

  private static func rowOf(_ value: Any?) -> DetectRow? { DetectRow(json: value) }

  private static func rowsOf(_ value: Any?) -> [DetectRow]? {
    guard let list = value as? [Any] else { return nil }
    let rows = list.compactMap { rowOf($0) }
    return rows.count == list.count ? rows : nil
  }

  private static func lastEndOf(_ value: Any?) -> DetectLastEnd? {
    guard let o = value as? [String: Any], let decidedAt = jsonNumber(o["decidedAt"]), let cut = jsonNumber(o["cut"]),
          let lat = jsonNumber(o["lat"]), let lng = jsonNumber(o["lng"]), let id = o["driveId"] as? String else { return nil }
    return DetectLastEnd(decidedAt: decidedAt, cut: cut, lat: lat, lng: lng, driveId: id)
  }

  private static func activityOf(_ value: Any) -> DetectActivity? {
    guard let o = value as? [String: Any], let start = jsonNumber(o["start"]), let automotive = jsonBool(o["automotive"]),
          let stationary = jsonBool(o["stationary"]), let onFoot = jsonBool(o["onFoot"]), let confident = jsonBool(o["confident"]) else { return nil }
    return DetectActivity(start: start, automotive: automotive, stationary: stationary, onFoot: onFoot, confident: confident)
  }

  private static func motionOf(_ value: Any?) -> DetectMotion? {
    guard let o = value as? [String: Any], let last = jsonNumber(o["lastAutomotiveAt"]), let since = jsonNumber(o["automotiveSince"]),
          let onFoot = jsonBool(o["onFootNow"]) else { return nil }
    return DetectMotion(lastAutomotiveAt: last, automotiveSince: since, onFootNow: onFoot)
  }

  private static func motionJSON(_ m: DetectMotion) -> [String: Any] {
    ["lastAutomotiveAt": m.lastAutomotiveAt, "automotiveSince": m.automotiveSince, "onFootNow": m.onFootNow]
  }

  private static func wakeOf(_ value: Any?) -> WakeCtx? {
    guard let o = value as? [String: Any], let now = jsonNumber(o["now"]), let reason = o["reason"] as? String, let phase = o["phase"] as? String,
          let armed = jsonBool(o["armed"]), let hasOwner = jsonBool(o["hasOwner"]), let ok = jsonBool(o["permissionsOk"]),
          let rest = jsonNumber(o["candidateRestUntil"]), let starts = o["candidateStarts"] as? [Any] else { return nil }
    let times = starts.compactMap { jsonNumber($0) }
    guard times.count == starts.count else { return nil }
    return WakeCtx(now: now, reason: reason, phase: phase, armed: armed, hasOwner: hasOwner, permissionsOk: ok, candidateRestUntil: rest, candidateStarts: times)
  }

  private static func statusInputsOf(_ value: Any?) -> StatusInputs? {
    guard let o = value as? [String: Any], let armed = jsonBool(o["armed"]), let hardware = jsonBool(o["hardware"]),
          let location = o["location"] as? String, let precise = jsonBool(o["precise"]), let motion = o["motion"] as? String,
          let refresh = o["backgroundRefresh"] as? String, let live = jsonBool(o["liveActivities"]) else { return nil }
    return StatusInputs(armed: armed, hardware: hardware, location: location, precise: precise, motion: motion, backgroundRefresh: refresh, liveActivities: live)
  }
}
