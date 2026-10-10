# DriveSense - the RoadWise background drive-capture module.
#
# 1 Hz location and 25 Hz motion capture reduced natively to
# one feature row per second, phone state, calls and the backup exclusion. README.md is the
# contract. The version is hard-coded rather than read from a package.json because this is a
# local Expo module with no package.json of its own.

Pod::Spec.new do |s|
  s.name           = 'DriveSense'
  s.version        = '0.3.0'
  s.summary        = 'Drive capture for RoadWise'
  s.author         = 'RoadWise'
  s.license        = { :type => 'Proprietary' }
  s.homepage       = 'https://github.com/LurpDaDerp/RoadCash'
  s.platforms      = { :ios => '15.1' }
  # Swift-only pod: CocoaPods aborts `pod install` for a pod with Swift sources and no declared
  # Swift version.
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'CoreLocation', 'CoreMotion', 'CallKit', 'LocalAuthentication'
  s.source_files = '**/*.{h,m,mm,swift}'
end
