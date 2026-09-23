# DmsVision: the RoadWise driver-monitoring native layer (README.md is the contract).
#
# Pinned native dependencies (verified on CocoaPods trunk 2026-09-18; the plan's keep table):
#   MediaPipeTasksVision 0.10.35   every build
#   onnxruntime-objc     1.30.0    ONLY with DMS_GAZE_NET=1 (the gaze network's release gate)
# Do NOT loosen these to optimistic operators: EAS builds must be reproducible.
#
# The gaze-net switch (plan: Global Constraints, the gaze_direct release gate). `gaze_direct.onnx`,
# its meta file, ONNX Runtime and the Swift that uses them are part of the pod only when the
# environment says DMS_GAZE_NET=1 at `pod install` time. Otherwise GazeNetStub/ supplies a GazeNet
# that reports itself unavailable. A production profile can never carry the switch: the install
# fails instead (plan rev2: rev1-M1).

gaze_net = ENV['DMS_GAZE_NET'] == '1'
if gaze_net && ENV['EAS_BUILD_PROFILE'] == 'production'
  raise 'DMS_GAZE_NET=1 is refused in a production build (release gate, U-2)'
end

Pod::Spec.new do |s|
  s.name           = 'DmsVision'
  s.version        = '2.0.0'
  s.summary        = 'Front-camera face features for the RoadWise driver-monitoring system.'
  s.description    = 'Owns a preview-free AVCaptureSession, runs MediaPipe FaceLandmarker and ' \
                     'emits derived per-frame feature records (never pixels or landmarks).'
  s.license        = { :type => 'MIT' }
  s.author         = 'RoadWise'
  s.homepage       = 'https://github.com/roadwise/dms-vision'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { :git => '' }

  # expo-modules-core requires static frameworks.
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'MediaPipeTasksVision', '0.10.35'

  xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  if gaze_net
    s.dependency 'onnxruntime-objc', '1.30.0'
    xcconfig['SWIFT_ACTIVE_COMPILATION_CONDITIONS'] = '$(inherited) DMS_GAZE_NET'
    s.resource_bundles = { 'DmsVision' => ['Resources/*', 'GazeNetResources/*'] }
    s.exclude_files = ['Pods/**', 'GazeNetStub/**']
  else
    s.resource_bundles = { 'DmsVision' => ['Resources/*'] }
    s.exclude_files = ['Pods/**', 'GazeNet/**']
  end

  s.pod_target_xcconfig = xcconfig
  s.source_files = '**/*.{h,m,mm,swift}'
end
