# DriveSense - the RoadWise background drive-capture module.
#
# M0 ships the shell: the module name, the event names, and getState(). The capture pipeline
# lands in M3. The version is hard-coded rather than read from a package.json because this is a
# local Expo module with no package.json of its own.

Pod::Spec.new do |s|
  s.name           = 'DriveSense'
  s.version        = '0.1.0'
  s.summary        = 'Background drive capture for RoadWise'
  s.author         = 'RoadWise'
  s.license        = 'Proprietary'
  s.homepage       = 'https://github.com/LurpDaDerp/RoadCash'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.{h,m,mm,swift}'
end
