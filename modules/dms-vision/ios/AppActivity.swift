// Whether the app is active, cached from the application notifications, so `start` (on the session
// queue) never blocks on the main thread to ask (Task 3 review nit).

import UIKit

final class AppActivity {
  static let shared = AppActivity()

  private let lock = NSLock()
  private var active = false

  private init() {
    let c = NotificationCenter.default
    c.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: nil) { [weak self] _ in
      self?.set(true)
    }
    c.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: nil) { [weak self] _ in
      self?.set(false)
    }
    // The state at creation; applicationState is read on the main thread only. Expo creates modules on
    // the main thread, so this is normally synchronous (round-1 review nit).
    if Thread.isMainThread {
      active = UIApplication.shared.applicationState == .active
    } else {
      DispatchQueue.main.async { [weak self] in self?.set(UIApplication.shared.applicationState == .active) }
    }
  }

  private func set(_ value: Bool) {
    lock.lock()
    active = value
    lock.unlock()
  }

  var isActive: Bool {
    lock.lock()
    defer { lock.unlock() }
    return active
  }
}
