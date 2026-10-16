// The forgot-to-start reminder's bounded GPS look on iOS: started by a wake whose session has had no
// reminder, it looks for a stop (at most 10 min; 3 min without 10 mph ends it); at a held stop it
// checks walking and notifications, posts the session's one note through the policy's gates, and
// ends. Every outcome ends the look. Its own manager: the capture's is never touched.
import CoreLocation
import Foundation

extension TripReminder {
  /// A look whose check never answers still ends: the look's 10 min plus 3 min.
  private static let lookBoundMs = TripReminderPolicy.IOS_LOOK_MAX_MS + TripReminderPolicy.IOS_LOOK_NO_DRIVE_MS

  // MARK: - The GPS look

  func startLook() {
    look = TripReminderPolicy.newLook(Self.nowMs())
    checking = false
    let m = lookManager
    m.activityType = .automotiveNavigation
    m.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
    m.distanceFilter = kCLDistanceFilterNone
    m.pausesLocationUpdatesAutomatically = false
    m.allowsBackgroundLocationUpdates = true
    m.showsBackgroundLocationIndicator = false
    m.startUpdatingLocation()
    let timer = DispatchSource.makeTimerSource(queue: .main)
    timer.schedule(wallDeadline: .now() + 5, repeating: 5)
    timer.setEventHandler { [weak self] in self?.tick() }
    timer.resume()
    clock = timer
  }

  /// The look's own clocks, so it ends on time even with no fixes, and even while a check is in
  /// flight (a check whose answer never comes cannot keep GPS on).
  private func tick() {
    guard let tr = look else { return }
    let now = Self.nowMs()
    if now - tr.startedAt >= Self.lookBoundMs {
      endLook("ended")
      return
    }
    guard !checking else { return }
    handle(TripReminderPolicy.lookClock(tr, now))
  }

  /// While a check is in flight the fixes still move the tracker (a car pulling away clears the
  /// stop, which the check then sees), but only the check acts.
  func onFix(_ l: CLLocation) {
    guard let tr = look else { return }
    let fix = ReminderFix(t: l.timestamp.timeIntervalSince1970 * 1000, speed: l.speed, speedAcc: l.speedAccuracy)
    let r = TripReminderPolicy.onFix(tr, fix, Self.nowMs())
    look = r.tracker
    if !checking { handle(r.verdict) }
  }

  /// The look `tr` is still the one running (a check's answer can outlive its look).
  private func current(_ tr: LookTracker) -> LookTracker? {
    guard let cur = look, cur.startedAt == tr.startedAt else { return nil }
    return cur
  }

  private func handle(_ verdict: String) {
    guard let tr = look else { return }
    switch verdict {
    case "stopped":
      checking = true
      ActivitySource.walkingBetween(Date(timeIntervalSince1970: tr.stopStart / 1000), Date()) { walked in
        self.stopped(tr, walked: walked)
      }
    case "no-drive", "look-max":
      endLook(verdict)
    default:
      break
    }
  }

  /// A held stop after its checks: post, arrival or end; the look ends either way. A fix during the
  /// checks that broke the stop (3 mph or more) means the car pulled away: no post, and the look
  /// looks again (10 mph first).
  private func stopped(_ tr: LookTracker, walked: Bool) {
    TripReminderNotifier.authorized { notificationsOk in
      guard let cur = self.current(tr) else { return }
      self.checking = false
      if cur.stopStart != tr.stopStart {
        self.look = TripReminderPolicy.seekAgain(cur, Self.nowMs())
        return
      }
      guard let s0 = self.loadState() else {
        self.endLook("ended")
        return
      }
      let token = UUID().uuidString
      let r = TripReminderPolicy.onStop(s0, self.context(notificationsOk: notificationsOk), Self.nowMs(), walked: walked, token: token, lastFastAt: cur.lastFastAt)
      self.saveState(r.state)
      if r.effect == "post" {
        TripReminderNotifier.post(token) { added in
          // A note that never showed is taken back: the session may remind at its next stop.
          if !added, let s1 = self.loadState() { self.saveState(TripReminderPolicy.unposted(s1, token)) }
        }
      }
      self.endLook("stopped")
    }
  }

  /// The look ends: GPS off, and its last 10 mph fix folds into the session; one that ran its full
  /// 10 min rests the next for 10 min.
  func endLook(_ verdict: String) {
    guard let tr = look else { return }
    look = nil
    checking = false
    clock?.setEventHandler {}
    clock?.cancel()
    clock = nil
    lookManager.stopUpdatingLocation()
    lookManager.allowsBackgroundLocationUpdates = false
    if let s0 = loadState() { saveState(TripReminderPolicy.lookEnded(s0, Self.nowMs(), tr.lastFastAt, verdict)) }
  }
}
