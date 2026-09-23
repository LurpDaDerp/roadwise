// MediaPipe FaceLandmarker in LIVE_STREAM mode, with the facial transformation matrix on (the head
// pose source). Every symbol is verified against MediaPipeTasksVision 0.10.35: MPPBaseOptions
// {modelAssetPath, delegate}, MPPFaceLandmarkerOptions {runningMode, numFaces, min*Confidence,
// outputFaceBlendshapes, outputFacialTransformationMatrixes, faceLandmarkerLiveStreamDelegate},
// detectAsync(image:timestampInMilliseconds:), and MPPTransformMatrix {rows, columns, data}.
// Landmarks come back in the UNROTATED buffer frame (measured in V1).

import Foundation
import MediaPipeTasksVision

final class Landmarker: NSObject, FaceLandmarkerLiveStreamDelegate {
  /// (timestampMs, buffer-frame landmarks 478×3 or nil, the matrix's 16 floats as delivered or nil, error)
  typealias ResultHandler = (Int, [Double]?, [Double]?, String?) -> Void

  private var landmarker: FaceLandmarker?
  private let onResult: ResultHandler

  init(gpu: Bool, onResult: @escaping ResultHandler) throws {
    self.onResult = onResult
    super.init()
    guard let path = DmsBundle.path("face_landmarker", "task") else {
      throw DmsError.model("face_landmarker.task is not in the bundle")
    }
    let base = BaseOptions()
    base.modelAssetPath = path
    base.delegate = gpu ? .GPU : .CPU
    let options = FaceLandmarkerOptions()
    options.baseOptions = base
    options.runningMode = .liveStream
    options.numFaces = 1
    options.minFaceDetectionConfidence = 0.5
    options.minFacePresenceConfidence = 0.5
    options.minTrackingConfidence = 0.5
    options.outputFaceBlendshapes = false
    options.outputFacialTransformationMatrixes = true
    options.faceLandmarkerLiveStreamDelegate = self
    do {
      landmarker = try FaceLandmarker(options: options)
    } catch {
      throw DmsError.model("cannot create the FaceLandmarker: \(error.localizedDescription)")
    }
  }

  func detect(_ image: MPImage, timestampMs: Int) throws {
    guard let lm = landmarker else { throw DmsError.state("the landmarker is closed") }
    try lm.detectAsync(image: image, timestampInMilliseconds: timestampMs)
  }

  func close() {
    landmarker = nil
  }

  func faceLandmarker(_ faceLandmarker: FaceLandmarker, didFinishDetection result: FaceLandmarkerResult?,
                      timestampInMilliseconds: Int, error: Error?) {
    if let error = error {
      onResult(timestampInMilliseconds, nil, nil, error.localizedDescription)
      return
    }
    var landmarks: [Double]? = nil
    if let face = result?.faceLandmarks.first, face.count == Landmarks.count {
      var out = [Double](repeating: 0, count: Landmarks.floats)
      var finite = true
      for (i, p) in face.enumerated() {
        let x = Double(p.x), y = Double(p.y), z = Double(p.z)
        if !x.isFinite || !y.isFinite || !z.isFinite { finite = false; break }
        out[i * 3] = x
        out[i * 3 + 1] = y
        out[i * 3 + 2] = z
      }
      if finite { landmarks = out }
    }
    var matrix: [Double]? = nil
    if landmarks != nil, let m = result?.facialTransformationMatrixes.first, Int(m.rows) == 4, Int(m.columns) == 4 {
      // Copied as delivered; HeadPose.normaliseLayout decides the layout (Task 2 review I2).
      let p: UnsafeMutablePointer<Float>? = m.data
      if let p = p { matrix = (0..<16).map { Double(p[$0]) } }
    }
    onResult(timestampInMilliseconds, landmarks, matrix, nil)
  }
}
