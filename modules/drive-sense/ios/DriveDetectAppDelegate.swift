// The drive detector's launch hook (registered in expo-module.config.json `appDelegateSubscribers`).
// At didFinishLaunching (never willFinish) it asks for the wakes again (an app iOS relaunched for a
// significant-location change, a region exit or a visit must) and resumes or ends a drive the last
// process left open. It never reads the launch options and adds no notification delegate.
import ExpoModulesCore
import UIKit

public class DriveDetectAppDelegate: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    DriveDetector.shared.resumeAtLaunch()
    return true
  }
}
