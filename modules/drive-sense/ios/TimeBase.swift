// The time base and the row windows (port of `src/extract/timebase.ts`; README §7 "Time base"
// and "Windows").
//
// IMU samples are stamped on the monotonic uptime clock (`CMLogItem.timestamp`) and converted to
// epoch ms through ONE anchor per capture. `CLLocation.timestamp` is already a `Date` and is used
// directly. Each row's window is (previous row's ts, ts], so a late timer makes one window longer
// and the next shorter without dropping or double-counting a sample.
import Foundation

enum TimeBase {
  /// A converted stamp further than this from its arrival time falls back to the arrival time.
  static let TIMEBASE_MAX_SKEW_MS: Double = 2000
  /// A gap between row timestamps longer than this starts over with a first window.
  static let MAX_ROW_GAP_MS: Double = 2000
  /// The window of a capture's first row, and of the first row after a stall.
  static let FIRST_WINDOW_MS: Double = 1000

  /// Wall clock, epoch ms.
  static func nowEpochMs() -> Double { Date().timeIntervalSince1970 * 1000 }

  /// Wall clock as an integer epoch ms, for event payloads (JS rejects fractional ms).
  static func nowTs() -> NSNumber { NSNumber(value: Int64(jsRound(nowEpochMs()))) }

  /// An epoch-ms Date as an integer epoch ms.
  static func ts(_ date: Date) -> Int64 { Int64(jsRound(date.timeIntervalSince1970 * 1000)) }

  /// Exclusive start of the window closing at `ts`.
  static func windowStart(prevTs: Double?, ts: Double) -> Double {
    guard let p = prevTs, ts - p <= MAX_ROW_GAP_MS else { return ts - FIRST_WINDOW_MS }
    return p
  }

  /// Split `buffer` into the window (start, ts] sorted oldest first and what waits for later
  /// windows (t > ts). Items at or before `start` belong to a closed window: dropped and counted.
  static func takeWindow(_ buffer: [ImuSample], start: Double, ts: Double) -> (inWindow: [ImuSample], rest: [ImuSample], dropped: Int) {
    var inWindow: [ImuSample] = []
    var rest: [ImuSample] = []
    var dropped = 0
    for item in buffer {
      if item.t > ts {
        rest.append(item)
      } else if item.t > start {
        inWindow.append(item)
      } else {
        dropped += 1
      }
    }
    inWindow.sort { $0.t < $1.t }
    return (inWindow, rest, dropped)
  }

  /// The window's fix: the latest fix timestamp in (start, ts], whatever the arrival order.
  static func pickFix(_ fixes: [FixSample], start: Double, ts: Double) -> FixSample? {
    var best: FixSample?
    for f in fixes where f.t > start && f.t <= ts {
      if best == nil || f.t > best!.t { best = f }
    }
    return best
  }
}

/// `{ epochMs, clockMs }` read back to back when a capture starts (`toEpochMs` in the reference).
struct ClockAnchor {
  let epochMs: Double
  let clockMs: Double

  /// Reads `Date()` and `systemUptime` back to back.
  static func now() -> ClockAnchor {
    let epoch = Date().timeIntervalSince1970 * 1000
    let clock = ProcessInfo.processInfo.systemUptime * 1000
    return ClockAnchor(epochMs: epoch, clockMs: clock)
  }

  /// Uptime ms → epoch ms, falling back to `arrivalEpochMs` beyond TIMEBASE_MAX_SKEW_MS.
  func toEpochMs(_ clockMs: Double, arrivalEpochMs: Double) -> (t: Double, fellBack: Bool) {
    let t = epochMs + (clockMs - self.clockMs)
    return abs(t - arrivalEpochMs) > TimeBase.TIMEBASE_MAX_SKEW_MS ? (arrivalEpochMs, true) : (t, false)
  }
}
