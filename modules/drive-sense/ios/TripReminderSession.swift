// The forgot-to-start reminder's bounded GPS session on iOS: started by a wake that found a car
// trip, it looks for the first real stop (at most 10 min; 3 min without 10 mph ends it), posts
// the one notification through the policy's gates, then watches up to 5 min for the car moving
// on or the driver walking off, and stops. Its own manager: the capture's is never touched.
import CoreLocation
import Foundation

extension TripReminder {
  // MARK: - The GPS session

  func startSession() {
    tracker = TripReminderPolicy.newTracker(Self.nowMs())
    checking = false
    let m = sessionManager
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

  /// The session's own clocks, so it ends on time even with no fixes. The longest a session can
  /// last (10 min looking, then 5 min watching) holds even while a check is in flight, so a check
  /// whose answer never comes cannot keep GPS on.
  private func tick() {
    guard let tr = tracker else { return }
    let now = Self.nowMs()
    if now - tr.startedAt >= TripReminderPolicy.IOS_SESSION_MAX_MS + TripReminderPolicy.TTL_MS {
      if tr.watching { watchEnded("ttl") } else { endSession() }
      return
    }
    guard !checking else { return }
    handle(TripReminderPolicy.sessionClock(tr, now))
  }

  /// While a check is in flight the fixes still move the tracker (a car pulling away clears the
  /// stop, which the check then sees), but only the check acts.
  func onFix(_ l: CLLocation) {
    guard let tr = tracker else { return }
    let fix = ReminderFix(
      t: l.timestamp.timeIntervalSince1970 * 1000,
      speed: l.speed,
      speedAcc: l.speedAccuracy,
      hAcc: l.horizontalAccuracy,
      lat: l.coordinate.latitude,
      lng: l.coordinate.longitude
    )
    let r = TripReminderPolicy.onFix(tr, fix, Self.nowMs())
    tracker = r.tracker
    if !checking { handle(r.verdict) }
  }

  /// The session `tr` is still the one running (a check's answer can outlive its session).
  private func current(_ tr: SessionTracker) -> SessionTracker? {
    guard let cur = tracker, cur.startedAt == tr.startedAt else { return nil }
    return cur
  }

  private func handle(_ verdict: String) {
    guard let tr = tracker else { return }
    switch verdict {
    case "stopped":
      checking = true
      ActivitySource.walkingBetween(Date(timeIntervalSince1970: tr.stopStart / 1000), Date()) { walked in
        self.stopped(tr, walked: walked)
      }
    case "moved":
      checking = true
      ActivitySource.walkingBetween(Date().addingTimeInterval(-TripReminderPolicy.WALK_CHECK_MS / 1000), Date()) { walked in
        guard self.current(tr) != nil else { return }
        self.checking = false
        self.watchEnded(walked ? "arrival" : "driving")
      }
    case "driving", "ttl":
      watchEnded(verdict)
    case "no-drive", "session-max":
      endSession()
    default:
      break
    }
  }

  /// A held stop: post, look for the next stop, or end. A fix during the checks that broke the stop
  /// (3 mph or more) means the car pulled away: no post, and the session looks on.
  private func stopped(_ tr: SessionTracker, walked: Bool) {
    TripReminderNotifier.authorized { notificationsOk in
      guard let cur = self.current(tr) else { return }
      self.checking = false
      guard let s0 = self.loadState() else {
        self.endSession()
        return
      }
      if cur.stopStart != tr.stopStart { return }
      var ctx = self.context(notificationsOk: notificationsOk)
      ctx.inCall = CallObserver.anyCallActiveNow()
      let now = Self.nowMs()
      let r = TripReminderPolicy.onStop(s0, ctx, now, walked: walked)
      self.saveState(r.state)
      switch r.effect {
      case "post":
        TripReminderNotifier.post()
        self.tracker = TripReminderPolicy.watchFrom(cur, now)
        self.sessionManager.distanceFilter = 10
      case "seek":
        self.tracker = TripReminderPolicy.seekAgain(cur, now)
      default:
        self.endSession()
      }
    }
  }

  /// The note's watch ended: driven on (within 20 s: unseen, one more stop may remind), walked off, or 5 min.
  private func watchEnded(_ how: String) {
    TripReminderNotifier.remove()
    guard let tr = tracker, let s0 = loadState() else {
      endSession()
      return
    }
    let now = Self.nowMs()
    let r = TripReminderPolicy.onWatchEnd(s0, how, now)
    saveState(r.state)
    if r.seek {
      tracker = TripReminderPolicy.seekAgain(tr, now)
      sessionManager.distanceFilter = kCLDistanceFilterNone
    } else {
      endSession()
    }
  }

  func endSession() {
    guard tracker != nil else { return }
    tracker = nil
    checking = false
    clock?.setEventHandler {}
    clock?.cancel()
    clock = nil
    sessionManager.stopUpdatingLocation()
    sessionManager.allowsBackgroundLocationUpdates = false
    if let s0 = loadState() { saveState(TripReminderPolicy.sessionEnded(s0, Self.nowMs())) }
  }
}
