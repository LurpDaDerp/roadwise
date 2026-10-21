# LiveDrive - the RoadWise Live Activity / Dynamic Island bridge (iOS 16.2+; a no-op below).
#
# The widget extension that renders the activity lives in /targets/live-drive-widget (linked by
# @bacons/apple-targets). `LiveDriveAttributes.swift` must stay byte-identical in both places:
# ActivityKit matches the activity to its widget by that type.

Pod::Spec.new do |s|
  s.name           = 'LiveDrive'
  s.version        = '1.0.0'
  s.summary        = 'Live Activity for a RoadWise drive'
  s.author         = 'RoadWise'
  s.license        = { :type => 'Proprietary' }
  s.homepage       = 'https://github.com/LurpDaDerp/RoadCash'
  s.platforms      = { :ios => '15.1' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.weak_frameworks = 'ActivityKit'
  # Taking drive-sense's "Recording your drive" note down once an activity runs.
  s.frameworks = 'UserNotifications'
  s.source_files = '**/*.{h,m,mm,swift}'
end
