// Shared helpers for the DmsVision module: bundled-resource resolution, the landmark
// buffer-frame -> upright-frame transform, camera intrinsics and the thermal probe.
//
// Conventions (must match dms/gaze_inputs.js and the research pipeline):
//   * landmarks are MediaPipe normalized (x / W, y / H, z / W) of the UPRIGHT image;
//   * the serialized landmark buffer is 478 * 3 little-endian float32, point-major;
//   * focalScale = fx / uprightWidth, principal point assumed at the frame centre.

import ExpoModulesCore
import Foundation
import AVFoundation
import CoreMedia
import UIKit
import simd

let kDmsNumLandmarks = 478

// MARK: - Errors

internal final class DmsVisionException: GenericException<String> {
  override var reason: String { return param }
}

// MARK: - Bundled resources

/// Resolves a file that ships inside the module's `DmsVision` resource bundle.
///
/// CocoaPods puts a `resource_bundles` bundle inside the pod's framework when the app is
/// built with frameworks and inside the app bundle when it is built with static libraries,
/// so both locations are searched, then the plain main bundle as a last resort.
internal enum DmsVisionBundle {
  private static let bundleName = "DmsVision"

  static func path(forResource name: String, ofType ext: String) -> String? {
    var candidates: [Bundle] = []
    let ownBundle = Bundle(for: DmsVisionBundleToken.self)
    for host in [ownBundle, Bundle.main] {
      if let url = host.url(forResource: bundleName, withExtension: "bundle"),
         let bundle = Bundle(url: url) {
        candidates.append(bundle)
      }
    }
    candidates.append(ownBundle)
    candidates.append(Bundle.main)

    for bundle in candidates {
      if let path = bundle.path(forResource: name, ofType: ext),
         FileManager.default.fileExists(atPath: path) {
        return path
      }
    }
    return nil
  }

  static func require(_ name: String, _ ext: String) throws -> String {
    guard let path = path(forResource: name, ofType: ext) else {
      throw DmsVisionException("Bundled resource \(name).\(ext) not found; check the DmsVision podspec resource_bundles")
    }
    return path
  }
}

/// Only exists so `Bundle(for:)` can find the framework this file was compiled into.
private final class DmsVisionBundleToken {}

// MARK: - Orientation

/// Clockwise rotation, in degrees, that must be applied to the delivered camera buffer for
/// its contents to be upright.
///
/// iPhone camera buffers are delivered in the sensor's native landscape orientation for both
/// the front and the back camera (AVFoundation's `videoRotationAngle` maps
/// `.landscapeRight` -> 0 and `.portrait` -> 90 for every device), so a portrait device needs
/// 90 degrees clockwise. Mirroring is disabled explicitly, so no mirrored variant applies.
internal func dmsRotationDegrees(for orientation: UIDeviceOrientation) -> Int {
  switch orientation {
  case .landscapeLeft: return 0
  case .landscapeRight: return 180
  case .portraitUpsideDown: return 270
  default: return 90       // .portrait, .faceUp, .faceDown, .unknown
  }
}

internal func dmsOrientationName(for orientation: UIDeviceOrientation) -> String {
  switch orientation {
  case .landscapeLeft: return "landscapeLeft"
  case .landscapeRight: return "landscapeRight"
  case .portraitUpsideDown: return "portraitUpsideDown"
  default: return "portrait"
  }
}

/// `UIImage.Orientation` whose MediaPipe rotation equals `degrees` clockwise.
///
/// Verified against mediapipe/tasks/ios/vision/core/sources/MPPVisionTaskRunner.mm, which maps
/// `.right` -> a 270 degree counter-clockwise NormalizedRect rotation (= 90 clockwise),
/// `.down` -> 180 and `.left` -> 90 counter-clockwise (= 270 clockwise).
internal func dmsImageOrientation(forClockwiseDegrees degrees: Int) -> UIImage.Orientation {
  switch ((degrees % 360) + 360) % 360 {
  case 90: return .right
  case 180: return .down
  case 270: return .left
  default: return .up
  }
}

// MARK: - Landmark transform

/// Rotates MediaPipe's normalized landmarks from the UNROTATED buffer frame into the upright
/// frame and serializes them as little-endian float32.
///
/// MediaPipe Tasks returns landmarks in the unrotated input frame even when a rotation is
/// requested. Measured with mediapipe 0.10.35 and this exact `face_landmarker.task`
/// (scratchpad probe, 2026-09-18): applying the transform below reproduces the landmarks of a
/// physically pre-rotated image to 0.003-0.005 normalized units (detector noise), while the
/// raw buffer-frame points differ by 0.28-0.45.
///
/// `z` is NOT rescaled. MediaPipe scales `z` by the length of the projected face-ROI x-axis
/// measured in the output (x / W, y / H) frame (landmark_projection_calculator.cc,
/// `CalculateZScale`), and the ROI follows the face, so for a 90/270 degree rotation `z` is
/// already divided by the upright width. The same probe measured max |z_rotated - z_reference|
/// = 0.0004-0.03 against 0.04-0.08 for the "z * bufferWidth / bufferHeight" alternative.
///
/// `interleaved` is (x, y, z) * 478 in the unrotated buffer frame.
internal func dmsSerializeLandmarks(_ interleaved: [Float], rotationDegrees: Int) -> Data {
  var out = interleaved
  let rotation = ((rotationDegrees % 360) + 360) % 360
  if rotation != 0 {
    var i = 0
    while i + 2 < out.count {
      let bx = out[i], by = out[i + 1]
      switch rotation {
      case 90:  out[i] = 1.0 - by; out[i + 1] = bx
      case 180: out[i] = 1.0 - bx; out[i + 1] = 1.0 - by
      case 270: out[i] = by;       out[i + 1] = 1.0 - bx
      default:  break
      }
      i += 3
    }
  }
  return out.withUnsafeBufferPointer { Data(buffer: $0) }
}

// MARK: - Intrinsics

internal struct DmsIntrinsics {
  /// Focal length in pixels of the delivered (unrotated) buffer.
  var fx: Double = 0
  var fy: Double = 0
  /// Principal point in pixels of the delivered (unrotated) buffer.
  var cx: Double = 0
  var cy: Double = 0
  var bufferWidth: Int = 0
  var bufferHeight: Int = 0
  /// "intrinsics" (sample-buffer attachment), "fov" (videoFieldOfView) or "default".
  var source: String = "default"

  static let defaultHorizontalFovDegrees: Double = 70.0

  static func fromFieldOfView(_ hfovDegrees: Double, width: Int, height: Int, source: String) -> DmsIntrinsics {
    var out = DmsIntrinsics()
    let hfov = (hfovDegrees > 1.0 && hfovDegrees < 179.0) ? hfovDegrees : defaultHorizontalFovDegrees
    let fx = Double(width) / (2.0 * tan(hfov * Double.pi / 360.0))
    out.fx = fx
    out.fy = fx                       // square pixels
    out.cx = Double(width) / 2.0
    out.cy = Double(height) / 2.0
    out.bufferWidth = width
    out.bufferHeight = height
    out.source = (hfovDegrees > 1.0 && hfovDegrees < 179.0) ? source : "default"
    return out
  }

  /// Upright image size after `rotationDegrees` clockwise.
  func uprightSize(rotationDegrees: Int) -> (width: Int, height: Int) {
    let swapped = (((rotationDegrees % 360) + 360) % 360) % 180 != 0
    return swapped ? (bufferHeight, bufferWidth) : (bufferWidth, bufferHeight)
  }

  /// `fx / uprightWidth`. A 90/270 degree rotation swaps the image axes, so the upright
  /// horizontal focal length is the buffer's vertical one.
  func focalScale(rotationDegrees: Int) -> Double {
    let swapped = (((rotationDegrees % 360) + 360) % 360) % 180 != 0
    let fxUpright = swapped ? fy : fx
    let uprightWidth = Double(swapped ? bufferHeight : bufferWidth)
    guard uprightWidth > 0, fxUpright.isFinite, fxUpright > 0 else { return 0 }
    return fxUpright / uprightWidth
  }
}

/// Reads `kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix` if the connection delivers it.
internal func dmsIntrinsicsFromSampleBuffer(_ sampleBuffer: CMSampleBuffer, width: Int, height: Int) -> DmsIntrinsics? {
  guard let raw = CMGetAttachment(sampleBuffer,
                                  key: kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix,
                                  attachmentModeOut: nil) as? Data,
        raw.count >= MemoryLayout<matrix_float3x3>.size else {
    return nil
  }
  var matrix = matrix_float3x3()
  withUnsafeMutableBytes(of: &matrix) { destination in
    raw.copyBytes(to: destination.bindMemory(to: UInt8.self),
                  from: 0..<MemoryLayout<matrix_float3x3>.size)
  }
  let fx = Double(matrix.columns.0.x)
  let fy = Double(matrix.columns.1.y)
  guard fx.isFinite, fy.isFinite, fx > 1.0, fy > 1.0 else { return nil }
  var out = DmsIntrinsics()
  out.fx = fx
  out.fy = fy
  out.cx = Double(matrix.columns.2.x)
  out.cy = Double(matrix.columns.2.y)
  out.bufferWidth = width
  out.bufferHeight = height
  out.source = "intrinsics"
  return out
}

// MARK: - Thermal

internal func dmsThermalStateName() -> String {
  switch ProcessInfo.processInfo.thermalState {
  case .nominal: return "nominal"
  case .fair: return "fair"
  case .serious: return "serious"
  case .critical: return "critical"
  @unknown default: return "unknown"
  }
}
