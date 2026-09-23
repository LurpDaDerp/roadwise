// DmsVision: the RoadWise driver-monitoring native module (iOS). README.md is the binding contract.
// Events: frames (derived feature records, never pixels or landmarks), status (1 Hz), state.
// Every rejection carries a contract code (DmsError.code).

import AVFoundation
import ExpoModulesCore

public final class DmsVisionModule: Module {
  private let controller = CaptureController.shared

  public func definition() -> ModuleDefinition {
    Name("DmsVision")

    Events("frames", "status", "state")

    OnCreate {
      _ = AppActivity.shared
      self.controller.onFrames = { [weak self] payload in self?.sendEvent("frames", payload.mapValues { $0 as Any? }) }
      self.controller.onState = { [weak self] state, reason in self?.sendEvent("state", ["state": state, "reason": reason]) }
      self.controller.onStatus = { [weak self] status in self?.sendEvent("status", status as [String: Any?]) }
      self.controller.onPreviewChange = { session in DmsPreviewRegistry.show(session) }
    }

    OnDestroy {
      let c = self.controller
      c.sessionQueue.async { c.stop(reason: "user") }
    }

    // The native owner of the camera across app states (plan: Privacy 5): leaving the foreground
    // stops the session. Native never restarts it; JS does, through the gate, on return.
    OnAppEntersBackground {
      let c = self.controller
      c.sessionQueue.async { c.stop(reason: "background") }
    }

    AsyncFunction("getPermission") { (promise: Promise) in
      promise.resolve(DmsVisionModule.permission(AVCaptureDevice.authorizationStatus(for: .video)))
    }

    AsyncFunction("requestPermission") { (promise: Promise) in
      if AVCaptureDevice.authorizationStatus(for: .video) != .notDetermined {
        promise.resolve(DmsVisionModule.permission(AVCaptureDevice.authorizationStatus(for: .video)))
        return
      }
      AVCaptureDevice.requestAccess(for: .video) { _ in
        promise.resolve(DmsVisionModule.permission(AVCaptureDevice.authorizationStatus(for: .video)))
      }
    }

    AsyncFunction("start") { (opts: StartOptionsRecord, promise: Promise) in
      do {
        let o = try opts.validated()
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
          throw DmsError.permission("camera permission has not been granted")
        }
        guard AppActivity.shared.isActive else { throw DmsError.notForeground("the app is not in the foreground") }
        try self.controller.start(token: o.token, fps: o.fps, gazeNet: o.gazeNet, every: o.every, gpu: o.gpu,
                                  rotationOffset: o.rotationOffset)
        promise.resolve(nil)
      } catch let e as DmsError {
        promise.reject(e.code, e.message)
      } catch {
        promise.reject("E_CAMERA", error.localizedDescription)
      }
    }.runOnQueue(controller.sessionQueue)

    AsyncFunction("setPolicy") { (p: CapturePolicyRecord, promise: Promise) in
      do {
        let v = try p.validated()
        try self.controller.setPolicy(token: v.token, capture: v.capture, fps: v.fps, gazeNet: v.gazeNet,
                                      every: v.every, setup: v.setupMode, preview: v.previewAllowed)
        promise.resolve(nil)
      } catch let e as DmsError {
        promise.reject(e.code, e.message)
      } catch {
        promise.reject("E_STATE", error.localizedDescription)
      }
    }.runOnQueue(controller.sessionQueue)

    AsyncFunction("stop") { (promise: Promise) in
      self.controller.stop(reason: "user")
      promise.resolve(nil)
    }.runOnQueue(controller.sessionQueue)

    AsyncFunction("getStatus") { (promise: Promise) in
      promise.resolve(self.controller.snapshot(take: false))
    }.runOnQueue(controller.sessionQueue)

    AsyncFunction("getModelInfo") { (promise: Promise) in
      let landmarker: String = DmsBundle.path("face_landmarker", "task").flatMap { DmsVisionModule.sha256(path: $0) } ?? ""
      let info: [String: Any?] = [
        "landmarkerSha256": landmarker,
        "gazeNetAvailable": GazeNetFactory.available,
        "gazeSha256": GazeNetFactory.modelSha256(),
        "mediapipe": "0.10.35",
        "onnxruntime": GazeNetFactory.onnxRuntimeVersion,
      ]
      promise.resolve(info)
    }

    AsyncFunction("selfTest") { (vectorsJson: String, promise: Promise) in
      do {
        promise.resolve(try SelfTest.run(vectorsJson))
      } catch let e as DmsError {
        promise.reject(e.code, e.message)
      } catch {
        promise.reject("E_BAD_ARGS", error.localizedDescription)
      }
    }

    View(DmsPreviewView.self) {}
  }

  private static func permission(_ status: AVAuthorizationStatus) -> [String: Any] {
    let s = status == .authorized ? "granted" : (status == .notDetermined ? "undetermined" : "denied")
    return ["status": s, "canAskAgain": status == .notDetermined]
  }
}
