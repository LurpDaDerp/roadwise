// CaptureController, continued: the 1 Hz tick (watchdog, release, thermal floor, status), the
// status snapshot with process CPU, and the interruption, thermal and orientation notifications.

import AVFoundation
import UIKit

extension CaptureController {
  // MARK: - The 1 Hz tick (tickQueue → sessionQueue): watchdog, release, thermal, status

  func startTick() {
    let t = DispatchSource.makeTimerSource(queue: tickQueue)
    t.schedule(wallDeadline: .now() + 1.0, repeating: 1.0)
    t.setEventHandler { [weak self] in self?.sessionQueue.async { self?.onTick() } }
    t.resume()
    tick = t
  }

  func stopTick() {
    tick?.setEventHandler {}
    tick?.cancel()
    tick = nil
  }

  func onTick() {
    let now = CaptureController.hostMs()
    let moved = locked { thermal.observe(CaptureController.thermalName(), nowMs: now) }
    let (st, hb, since, cameraOk) = locked { (state, lastHeartbeatMs, pausedSinceMs, thermal.allowsCamera) }
    if moved { applyCadence() }
    if st == "running" && !cameraOk { pause("thermal") }
    switch LifecycleRules.decide(nowMs: now, running: st == "running", paused: st == "paused", lastHeartbeatMs: hb, pausedSinceMs: since) {
    case .pauseWatchdog: pause("watchdog"); DmsLog.code(.watchdogPaused)
    case .stopWatchdog: stop(reason: "watchdog"); DmsLog.code(.watchdogStopped)
    case .release: stop(reason: "released"); DmsLog.code(.modelsReleased)
    case .none: break
    }
    if currentState != "stopped" {
      let s = snapshot(take: true)
      onStatus?(s)
    }
  }

  static func thermalName() -> String {
    switch ProcessInfo.processInfo.thermalState {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
  }

  /// The status payload. `take` consumes the latency windows and the counters (the 1 Hz tick only).
  func snapshot(take: Bool) -> [String: Any?] {
    return locked {
      if !take, let last = lastStatus { var s = last; s["state"] = state; return s }
      let running = state == "running"
      let lm = latLandmark.take(), gz = latGaze.take(), tot = latTotal.take()
      var usage = rusage()
      getrusage(RUSAGE_SELF, &usage)
      let cpuMs = Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000
        + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000
      let wall = CaptureController.hostMs()
      var cpu: Double? = nil
      if let prev = cpuPrevMs, wall > cpuPrevWallMs { cpu = (cpuMs - prev) / ((wall - cpuPrevWallMs) / 1000) }
      cpuPrevMs = cpuMs
      cpuPrevWallMs = wall
      let status: [String: Any?] = [
        "state": state,
        "fpsTarget": running ? Double(min(fps, thermal.fpsCap)) : 0.0,
        "fpsActual": Double(processed),
        "dropped": dropped,
        "gazeNetAvailable": GazeNetFactory.available,
        "gazeNetOn": running && GazeNetFactory.available && gazeNetWanted && thermal.allowsGazeNet,
        "thermal": CaptureController.thermalName(),
        "thermalLevel": thermal.level,
        "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
        "latLandmarkP50": lm.p50, "latLandmarkP95": lm.p95,
        "latGazeP50": gz.p50, "latGazeP95": gz.p95,
        "latTotalP50": tot.p50, "latTotalP95": tot.p95,
        "procCpuMsPerS": cpu.map { max(0, $0) },
      ]
      processed = 0
      dropped = 0
      lastStatus = status
      return status
    }
  }

  // MARK: - Interruptions and thermal notifications

  func addObservers(_ s: AVCaptureSession) {
    let c = NotificationCenter.default
    c.addObserver(self, selector: #selector(onInterrupted), name: .AVCaptureSessionWasInterrupted, object: s)
    c.addObserver(self, selector: #selector(onInterruptionEnded), name: .AVCaptureSessionInterruptionEnded, object: s)
    c.addObserver(self, selector: #selector(onRuntimeError), name: .AVCaptureSessionRuntimeError, object: s)
    c.addObserver(self, selector: #selector(onThermal), name: ProcessInfo.thermalStateDidChangeNotification, object: nil)
    c.addObserver(self, selector: #selector(onOrientation), name: UIDevice.orientationDidChangeNotification, object: nil)
    DispatchQueue.main.async {
      UIDevice.current.beginGeneratingDeviceOrientationNotifications()
      self.onOrientation()
    }
  }

  func removeObservers(_ s: AVCaptureSession) {
    NotificationCenter.default.removeObserver(self)
    DispatchQueue.main.async { UIDevice.current.endGeneratingDeviceOrientationNotifications() }
  }

  @objc func onInterrupted() {
    sessionQueue.async {
      self.locked { self.interrupted = true }
      if self.currentState == "running" { self.pause("interrupted"); DmsLog.code(.cameraInterrupted) }
    }
  }

  /// Never resumes by itself: the next `run` policy from JS does (Task 3 review m3).
  @objc func onInterruptionEnded() {
    sessionQueue.async { self.locked { self.interrupted = false } }
  }

  @objc func onRuntimeError() {
    sessionQueue.async { if self.currentState == "running" { self.pause("error"); DmsLog.code(.cameraRuntimeError) } }
  }

  @objc func onThermal() {
    sessionQueue.async { self.onTickThermalOnly() }
  }

  func onTickThermalOnly() {
    let now = CaptureController.hostMs()
    if locked({ thermal.observe(CaptureController.thermalName(), nowMs: now) }) { applyCadence() }
    if currentState == "running" && !locked({ thermal.allowsCamera }) { pause("thermal") }
  }

  @objc func onOrientation() {
    DispatchQueue.main.async {
      let o = UIDevice.current.orientation
      if [.portrait, .portraitUpsideDown, .landscapeLeft, .landscapeRight].contains(o) { self.locked { self.orientation = o } }
    }
  }
}
