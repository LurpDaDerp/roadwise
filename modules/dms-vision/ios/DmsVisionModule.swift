// DmsVision - the RoadCash driver-monitoring native inference layer (iOS).
//
// JS contract: see modules/dms-vision/src/index.js and docs/dms/NATIVE_LAYER.md.
// Events: onFrame (one per processed camera frame), onStatus (1 Hz), onError.

import ExpoModulesCore
import AVFoundation
import Foundation

public final class DmsVisionModule: Module, DmsVisionPipelineDelegate {
  private let pipeline = DmsVisionPipeline()
  private let gaze = DmsVisionGaze()
  /// Touched only on `statusQueue` (create, resume and cancel all happen there).
  private var statusTimer: DispatchSourceTimer?
  private let statusQueue = DispatchQueue(label: "com.roadcash.dmsvision.status")

  public func definition() -> ModuleDefinition {
    Name("DmsVision")

    Events("onFrame", "onStatus", "onError")

    OnCreate {
      self.pipeline.delegate = self
    }

    OnDestroy {
      self.stopStatusTimer()
      // Never block the main thread on a capture-session teardown: the stop waits for the
      // session queue, which may be inside startRunning().
      let pipeline = self.pipeline
      let gaze = self.gaze
      pipeline.sessionQueue.async {
        pipeline.stopOnSessionQueue()
        gaze.close()
      }
    }

    // NOTE (docs/dms/INTEGRATION.md §3): there is deliberately NO OnAppEntersBackground handler.
    // The JS AppState listener is the single owner of the camera across app-state changes; two
    // owners left the JS-visible state and the native session disagreeing. iOS interrupts the
    // session by itself when the app leaves the foreground, and that interruption is reported
    // through onError / onStatus below, which is what the JS watchdog reacts to.

    Function("isAvailable") { () -> Bool in
      return true
    }

    AsyncFunction("getPermissionsAsync") { () -> [String: Any] in
      return Self.permissionPayload(AVCaptureDevice.authorizationStatus(for: .video))
    }

    AsyncFunction("requestPermissionsAsync") { (promise: Promise) in
      let status = AVCaptureDevice.authorizationStatus(for: .video)
      if status != .notDetermined {
        promise.resolve(Self.permissionPayload(status))
        return
      }
      AVCaptureDevice.requestAccess(for: .video) { _ in
        promise.resolve(Self.permissionPayload(AVCaptureDevice.authorizationStatus(for: .video)))
      }
    }

    // start / stop configure and tear down an AVCaptureSession, which takes tens of
    // milliseconds and must not run on the shared Expo async queue (every other module's async
    // functions would queue behind it). `.runOnQueue` puts the body on the pipeline's own
    // session queue - the queue the pipeline serialises its state on - so the bodies below call
    // the "...OnSessionQueue" entry points and never nest a `sync` on it (that deadlocks).
    AsyncFunction("start", { (targetFps: Double, facing: String, landmarkFrame: String,
                              mirrorPair: Bool, rotationOffsetDegrees: Int) in
      if mirrorPair {
        // TODO(mirror-pair): the promoted research recipe runs the mesh twice (frame + flipped
        // frame) and averages through the 478-point mirror permutation, which is worth ~0.32 deg
        // of LBW error. Out of scope for this version; implement in the pipeline, not in JS.
        throw DmsVisionException("mirrorPair is not implemented in this version; pass false")
      }
      guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
        throw DmsVisionException("camera permission has not been granted")
      }
      try self.gaze.prepare()
      try self.pipeline.startOnSessionQueue(targetFps: targetFps,
                                            facing: facing,
                                            landmarkFrame: landmarkFrame,
                                            rotationOffsetDegrees: rotationOffsetDegrees)
      self.startStatusTimer()
    })
    .runOnQueue(self.pipeline.sessionQueue)

    AsyncFunction("stop", { () -> Void in
      self.stopStatusTimer()
      self.pipeline.stopOnSessionQueue()
    })
    .runOnQueue(self.pipeline.sessionQueue)

    Function("setTargetFps") { (fps: Double) in
      self.pipeline.setTargetFps(fps)
    }

    Function("setIdleMode") { (idle: Bool) in
      self.pipeline.setIdleMode(idle)
    }

    Function("getIntrinsics") { () -> [String: Any] in
      return self.pipeline.intrinsicsReport()
    }

    Function("getThermalState") { () -> String in
      return dmsThermalStateName()
    }

    Function("getModelInfo") { () -> [String: Any] in
      let meta = try self.gaze.loadMetadata()
      return [
        "onnxSha256": (meta["onnx_sha256"] as? String) ?? "",
        "parameters": (meta["parameters"] as? Int) ?? 0
      ]
    }

    AsyncFunction("predictGaze") { (cloud: Data, context: Data, validity: Data) -> Data in
      return try self.gaze.predict(cloud: cloud, context: context, validity: validity)
    }
  }

  // MARK: - Status

  /// Created, resumed and cancelled on `statusQueue` only: a DispatchSourceTimer released before
  /// it was resumed traps in libdispatch, and cancelling one from another thread while its
  /// handler runs is a data race on `statusTimer`.
  private func startStatusTimer() {
    statusQueue.sync {
      self.cancelStatusTimerOnQueue()
      let timer = DispatchSource.makeTimerSource(queue: self.statusQueue)
      timer.schedule(deadline: .now() + 1.0, repeating: 1.0)
      timer.setEventHandler { [weak self] in
        guard let self = self else { return }
        self.sendEvent("onStatus", self.statusPayload(stopped: false))
      }
      timer.resume()                 // resumed BEFORE it is published
      self.statusTimer = timer
    }
  }

  private func stopStatusTimer() {
    statusQueue.sync { self.cancelStatusTimerOnQueue() }
  }

  /// `statusQueue` only.
  private func cancelStatusTimerOnQueue() {
    guard let timer = statusTimer else { return }
    statusTimer = nil
    timer.setEventHandler {}         // drop the captured self before cancelling
    timer.cancel()
  }

  private func statusPayload(stopped: Bool) -> [String: Any?] {
    let counters = pipeline.takeCounters()
    let payload: [String: Any?] = [
      "thermal": dmsThermalStateName(),
      "lowPower": ProcessInfo.processInfo.isLowPowerModeEnabled,
      "fps": stopped ? 0.0 : Double(counters.processed),
      "dropped": counters.dropped,
      "running": pipeline.isRunning
    ]
    return payload
  }

  private static func permissionPayload(_ status: AVAuthorizationStatus) -> [String: Any] {
    let granted = status == .authorized
    return [
      "status": granted ? "granted" : (status == .notDetermined ? "undetermined" : "denied"),
      "granted": granted,
      "canAskAgain": status == .notDetermined,
      "expires": "never"
    ]
  }

  // MARK: - DmsVisionPipelineDelegate

  func pipelineDidProduce(frame: [String: Any?]) {
    sendEvent("onFrame", frame)
  }

  func pipelineDidFail(code: String, message: String) {
    let payload: [String: Any?] = ["code": code, "message": message]
    sendEvent("onError", payload)
  }

  /// The OS interrupted or resumed the session (a call, another app taking the camera, the app
  /// leaving the foreground). The JS side reads `running` from this status event and restarts
  /// the session when the app is active again (docs/dms/INTEGRATION.md §3).
  func pipelineDidChangeRunning(_ running: Bool) {
    sendEvent("onStatus", statusPayload(stopped: !running))
  }
}
