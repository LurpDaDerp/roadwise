// AVFoundation helpers for CaptureController (the V1 techniques, re-homed):
// - a preview-free session with one video data output (BGRA);
// - the lowest format whose long side is ≥ 640 px at 30 fps, zoom 1.0;
// - stabilisation OFF (it stops intrinsics delivery) and mirroring OFF;
// - the device frame duration driven at the cadence, with the exposure capped at 1/30 s so a slow
//   cadence cannot blur the face;
// - the orientation → clockwise rotation table and the camera intrinsics (focalScale for the gaze net).

import AVFoundation
import CoreMedia
import UIKit
import simd

enum CaptureSetup {
  /// A configured, not-yet-running session with its device and output, or DmsError.camera.
  static func make(delegate: AVCaptureVideoDataOutputSampleBufferDelegate, queue: DispatchQueue) throws
    -> (session: AVCaptureSession, device: AVCaptureDevice, output: AVCaptureVideoDataOutput) {
    guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else {
      throw DmsError.camera("no front camera")
    }
    let session = AVCaptureSession()
    session.beginConfiguration()
    session.sessionPreset = .inputPriority
    defer { session.commitConfiguration() }
    let input: AVCaptureDeviceInput
    do { input = try AVCaptureDeviceInput(device: camera) } catch {
      throw DmsError.camera("cannot open the front camera: \(error.localizedDescription)")
    }
    guard session.canAddInput(input) else { throw DmsError.camera("the session refused the camera input") }
    session.addInput(input)
    let output = AVCaptureVideoDataOutput()
    output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
    output.alwaysDiscardsLateVideoFrames = true
    output.setSampleBufferDelegate(delegate, queue: queue)
    guard session.canAddOutput(output) else { throw DmsError.camera("the session refused the video output") }
    session.addOutput(output)
    if let format = pickFormat(camera) {
      if (try? camera.lockForConfiguration()) != nil {
        camera.activeFormat = format
        camera.videoZoomFactor = 1.0
        camera.unlockForConfiguration()
      }
    }
    if let connection = output.connection(with: .video) {
      connection.automaticallyAdjustsVideoMirroring = false
      if connection.isVideoMirroringSupported { connection.isVideoMirrored = false }
      if connection.isVideoStabilizationSupported { connection.preferredVideoStabilizationMode = .off }
      if connection.isCameraIntrinsicMatrixDeliverySupported { connection.isCameraIntrinsicMatrixDeliveryEnabled = true }
    }
    return (session, camera, output)
  }

  static func pickFormat(_ device: AVCaptureDevice) -> AVCaptureDevice.Format? {
    var best: AVCaptureDevice.Format?
    var bestArea = Int.max
    for format in device.formats {
      let d = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
      let w = Int(d.width), h = Int(d.height)
      guard max(w, h) >= 640, min(w, h) > 0 else { continue }
      guard format.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= 30 && $0.maxFrameRate >= 30 }) else { continue }
      if w * h < bestArea { bestArea = w * h; best = format }
    }
    return best
  }

  /// Drive the sensor at `fps` (never below it), capping exposure at 1/30 s. Returns the applied rate.
  @discardableResult
  static func applyCadence(_ device: AVCaptureDevice, fps: Double) -> Double {
    var best = Double.greatestFiniteMagnitude
    var fastest = 0.0
    for range in device.activeFormat.videoSupportedFrameRateRanges {
      fastest = max(fastest, range.maxFrameRate)
      let candidate = min(max(fps, range.minFrameRate), range.maxFrameRate)
      if candidate >= fps - 0.01 && candidate < best { best = candidate }
    }
    let wanted = best == Double.greatestFiniteMagnitude ? (fastest > 0 ? fastest : 30) : best
    guard (try? device.lockForConfiguration()) != nil else { return 0 }
    let duration = CMTimeMake(value: 1000, timescale: Int32((wanted * 1000).rounded()))
    device.activeVideoMinFrameDuration = duration
    device.activeVideoMaxFrameDuration = duration
    var cap = CMTimeMake(value: 1, timescale: 30)
    let format = device.activeFormat
    if CMTimeCompare(cap, format.minExposureDuration) < 0 { cap = format.minExposureDuration }
    if CMTimeCompare(cap, format.maxExposureDuration) > 0 { cap = format.maxExposureDuration }
    if cap.isValid && !cap.isIndefinite { device.activeMaxExposureDuration = cap }
    device.unlockForConfiguration()
    return wanted
  }

  /// Clockwise rotation from the delivered buffer to upright (portrait → 90).
  static func rotationDegrees(_ orientation: UIDeviceOrientation) -> Int {
    switch orientation {
    case .landscapeLeft: return 0
    case .landscapeRight: return 180
    case .portraitUpsideDown: return 270
    default: return 90
    }
  }

  /// MediaPipe's image orientation for a clockwise rotation (verified against MPPVisionTaskRunner).
  static func imageOrientation(_ degrees: Int) -> UIImage.Orientation {
    switch ((degrees % 360) + 360) % 360 {
    case 90: return .right
    case 180: return .down
    case 270: return .left
    default: return .up
    }
  }

  /// fx / uprightWidth from the sample's intrinsic matrix, else the format's field of view, else 70°.
  static func focalScale(_ sample: CMSampleBuffer, width: Int, height: Int, rotation: Int, fovDegrees: Double) -> Double {
    let swapped = rotation % 180 != 0
    let uprightWidth = Double(swapped ? height : width)
    if let raw = CMGetAttachment(sample, key: kCMSampleBufferAttachmentKey_CameraIntrinsicMatrix, attachmentModeOut: nil) as? Data,
       raw.count >= MemoryLayout<matrix_float3x3>.size {
      var m = matrix_float3x3()
      withUnsafeMutableBytes(of: &m) { raw.copyBytes(to: $0.bindMemory(to: UInt8.self), from: 0..<MemoryLayout<matrix_float3x3>.size) }
      let fx = Double(swapped ? m.columns.1.y : m.columns.0.x)
      if fx.isFinite && fx > 1 && uprightWidth > 0 { return fx / uprightWidth }
    }
    let hfov = (fovDegrees > 1 && fovDegrees < 179) ? fovDegrees : 70
    let fxBuffer = Double(width) / (2 * tan(hfov * Double.pi / 360))
    // With a 90° rotation the upright horizontal focal length is the buffer's vertical one (square pixels).
    return uprightWidth > 0 ? fxBuffer / uprightWidth : 0
  }
}
