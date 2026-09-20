# DmsVision — the RoadCash driver-monitoring native inference layer.
#
# Pinned native dependencies (verified on CocoaPods trunk 2026-09-18):
#   MediaPipeTasksVision 0.10.35  (published 2026-04-27, ios >= 15.0, static framework)
#   onnxruntime-objc     1.30.0   (published 2026-09-11, ios >= 15.1, static framework,
#                                  pulls onnxruntime-c 1.30.0)
# Do NOT loosen these to optimistic operators: EAS builds must be reproducible.

Pod::Spec.new do |s|
  s.name           = 'DmsVision'
  s.version        = '1.0.0'
  s.summary        = 'Front-camera MediaPipe FaceLandmarker + ONNX gaze inference for RoadCash.'
  s.description    = 'Owns a preview-free AVCaptureSession, runs MediaPipe FaceLandmarker in ' \
                     'LIVE_STREAM mode and the gaze network through ONNX Runtime, and emits ' \
                     'upright-normalized 478-point landmark clouds to JavaScript.'
  s.license        = { :type => 'MIT' }
  s.author         = 'RoadCash'
  s.homepage       = 'https://github.com/roadcash/RoadCash-dms'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }

  # expo-modules-core requires static frameworks.
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'MediaPipeTasksVision', '0.10.35'
  s.dependency 'onnxruntime-objc', '1.30.0'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  # The model bundle ships as a native resource bundle, so no download and no
  # expo-asset copy is needed. Resolved at runtime by DmsVisionBundle.swift, which
  # looks in both the framework bundle and the main bundle (CocoaPods places
  # resource bundles differently for static libraries and for frameworks).
  s.resource_bundles = {
    'DmsVision' => ['Resources/*']
  }

  s.source_files = '**/*.{h,m,mm,swift}'
  s.exclude_files = 'Pods/**'
end
