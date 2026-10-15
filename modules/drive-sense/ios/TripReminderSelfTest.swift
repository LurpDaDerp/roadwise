// The forgot-to-start reminder's half of the on-device self-test (README §10 "Self-test"). Each
// `reminder` vector carries one row of `src/reminder/vectors.ts` without its `expected`; this runs
// it through the PRODUCTION `TripReminderPolicy` (never a copy) and answers the row's `actual`,
// which `src/reminder/selfTest.ts` matches against the row's `expected`. The activity-transition
// rows are Android's and are answered `skipped`. Pure: nothing here touches the phone, the stored
// state or a notification.
import Foundation

enum TripReminderSelfTest {
  private struct Bad: Error {
    let message: String
  }

  /// The result object for one vector: `actual`, `skipped`, or `error` for a malformed row.
  static func result(_ name: String, _ inputs: Any?) -> [String: Any] {
    var out: [String: Any] = ["name": name, "kind": "reminder"]
    do {
      guard let row = inputs as? [String: Any], let kind = row["kind"] as? String else {
        throw Bad(message: "inputs is not a reminder row")
      }
      if kind == "transitions" {
        out["skipped"] = "activity transitions are an Android rule"
      } else {
        out["actual"] = try actual(kind, row)
      }
    } catch let e as Bad {
      out["error"] = e.message
    } catch {
      out["error"] = "\(error)"
    }
    return out
  }

  private static func actual(_ kind: String, _ row: [String: Any]) throws -> [String: Any] {
    switch kind {
    case "gate":
      let s = try state(row["state"])
      let c = try ctx(row["ctx"])
      let now = try num(row["now"])
      let ph = try phase(row["phase"])
      return ["reason": TripReminderPolicy.gate(s, c, now, ph)]
    case "ops":
      var s = try state(row["state"])
      guard let ops = row["ops"] as? [Any] else { throw Bad(message: "ops is missing") }
      for raw in ops {
        s = try op(s, raw)
      }
      return try ["state": stateJson(s)]
    case "wake":
      let s = try state(row["state"])
      let now = try num(row["now"])
      let m = try motion(row["motion"])
      let c = try ctx(row["ctx"])
      let r = TripReminderPolicy.onWake(s, now, m, c)
      return try ["effect": r.startSession ? "start-session" : "none", "reason": r.reason, "state": stateJson(r.state)]
    case "summary":
      guard let list = row["activities"] as? [Any] else { throw Bad(message: "activities is missing") }
      let acts = try list.map { try activity($0) }
      let m = try TripReminderPolicy.summarize(acts, num(row["now"]))
      return ["summary": ["lastAutomotiveAt": m.lastAutomotiveAt, "automotiveSince": m.automotiveSince, "onFootNow": m.onFootNow]]
    case "fixes":
      var tr = try tracker(row["tracker"])
      guard let fixes = row["fixes"] as? [Any] else { throw Bad(message: "fixes is missing") }
      var verdicts: [String] = []
      for raw in fixes {
        guard let f = raw as? [String: Any] else { throw Bad(message: "a fix is malformed") }
        let one = try fix(f["fix"])
        let now = try num(f["now"])
        let r = TripReminderPolicy.onFix(tr, one, now)
        tr = r.tracker
        verdicts.append(r.verdict)
      }
      return ["verdicts": verdicts]
    case "stop":
      let s = try state(row["state"])
      let c = try ctx(row["ctx"])
      let now = try num(row["now"])
      guard let walked = jsonBool(row["walked"]) else { throw Bad(message: "walked is missing") }
      let r = TripReminderPolicy.onStop(s, c, now, walked: walked)
      return ["effect": r.effect, "reason": r.reason]
    case "watchEnd":
      let s = try state(row["state"])
      let now = try num(row["now"])
      guard let how = row["how"] as? String else { throw Bad(message: "how is missing") }
      let r = TripReminderPolicy.onWatchEnd(s, how, now)
      return try ["effect": r.seek ? "seek" : "end", "state": stateJson(r.state)]
    default:
      throw Bad(message: "unknown reminder row kind \(kind)")
    }
  }

  private static func op(_ s: ReminderState, _ raw: Any) throws -> ReminderState {
    guard let o = raw as? [String: Any], let name = o["op"] as? String else { throw Bad(message: "an op is malformed") }
    switch name {
    case "settle":
      return try TripReminderPolicy.settle(s, num(o["now"]))
    case "posted":
      var p = s
      try TripReminderPolicy.postedIn(&p, num(o["now"]))
      return p
    case "resolve":
      let outcome = try outcomeOf(o["outcome"])
      return try TripReminderPolicy.resolve(s, outcome, num(o["now"]))
    case "captureStarted":
      return try TripReminderPolicy.captureStarted(s, num(o["now"]))
    case "captureEnded":
      return try TripReminderPolicy.captureEnded(s, num(o["now"]))
    case "appForeground":
      return TripReminderPolicy.appForeground(s)
    case "setEnabled":
      return try TripReminderPolicy.setEnabled(s, bool(o, "on"))
    case "sessionEnded":
      return try TripReminderPolicy.sessionEnded(s, num(o["now"]))
    default:
      throw Bad(message: "unknown op \(name)")
    }
  }

  // MARK: - Reading a row

  private static func num(_ v: Any?) throws -> Double {
    guard let n = jsonNumber(v) else { throw Bad(message: "a number is missing") }
    return n
  }

  private static func bool(_ o: [String: Any], _ key: String) throws -> Bool {
    guard let b = jsonBool(o[key]) else { throw Bad(message: "\(key) is missing") }
    return b
  }

  /// A row's state, decoded as the stored one is.
  private static func state(_ v: Any?) throws -> ReminderState {
    guard let o = v as? [String: Any], JSONSerialization.isValidJSONObject(o) else { throw Bad(message: "state is missing") }
    let data = try JSONSerialization.data(withJSONObject: o, options: [])
    guard let s = try? JSONDecoder().decode(ReminderState.self, from: data) else {
      throw Bad(message: "state is not a v2 ReminderState")
    }
    return s
  }

  private static func stateJson(_ s: ReminderState) throws -> Any {
    let data = try JSONEncoder().encode(s)
    return try JSONSerialization.jsonObject(with: data, options: [])
  }

  private static func ctx(_ v: Any?) throws -> ReminderCtx {
    guard let o = v as? [String: Any] else { throw Bad(message: "ctx is missing") }
    var c = ReminderCtx()
    c.permissionsOk = try bool(o, "permissionsOk")
    c.capturing = try bool(o, "capturing")
    c.appForeground = try bool(o, "appForeground")
    c.inCall = try bool(o, "inCall")
    c.lowPower = try bool(o, "lowPower")
    c.eventAgeMs = try num(o["eventAgeMs"])
    c.onFoot = try bool(o, "onFoot")
    // JSON has no Infinity: null stands for "no car motion".
    c.automotiveAgeMs = jsonNumber(o["automotiveAgeMs"]) ?? Double.infinity
    return c
  }

  private static func phase(_ v: Any?) throws -> TripReminderPolicy.Phase {
    switch v as? String {
    case "wake": return .wake
    case "session": return .session
    case "stop": return .stop
    default: throw Bad(message: "unknown gate phase")
    }
  }

  private static func outcomeOf(_ v: Any?) throws -> TripReminderPolicy.Outcome {
    switch v as? String {
    case "converted": return .converted
    case "unseen": return .unseen
    case "notDriving": return .notDriving
    case "missed": return .missed
    default: throw Bad(message: "unknown outcome")
    }
  }

  private static func motion(_ v: Any?) throws -> MotionSummary {
    guard let o = v as? [String: Any] else { throw Bad(message: "motion is missing") }
    return try MotionSummary(
      lastAutomotiveAt: num(o["lastAutomotiveAt"]),
      automotiveSince: num(o["automotiveSince"]),
      onFootNow: bool(o, "onFootNow")
    )
  }

  /// The table gives walking, running or cycling as one flag; the walking-only flag follows it.
  private static func activity(_ v: Any) throws -> ActivitySample {
    guard let o = v as? [String: Any] else { throw Bad(message: "an activity is malformed") }
    let onFoot = try bool(o, "onFoot")
    return try ActivitySample(
      start: num(o["start"]),
      automotive: bool(o, "automotive"),
      onFoot: onFoot,
      walking: onFoot,
      confident: bool(o, "confident")
    )
  }

  private static func tracker(_ v: Any?) throws -> SessionTracker {
    guard let o = v as? [String: Any] else { throw Bad(message: "tracker is missing") }
    return try SessionTracker(
      startedAt: num(o["startedAt"]),
      seekSince: num(o["seekSince"]),
      sawDriving: bool(o, "sawDriving"),
      stopStart: num(o["stopStart"]),
      stopLat: num(o["stopLat"]),
      stopLng: num(o["stopLng"]),
      watching: bool(o, "watching"),
      postedAt: num(o["postedAt"])
    )
  }

  private static func fix(_ v: Any?) throws -> ReminderFix {
    guard let o = v as? [String: Any] else { throw Bad(message: "fix is missing") }
    return try ReminderFix(
      t: num(o["t"]),
      speed: num(o["speed"]),
      speedAcc: num(o["speedAcc"]),
      hAcc: num(o["hAcc"]),
      lat: num(o["lat"]),
      lng: num(o["lng"])
    )
  }
}
