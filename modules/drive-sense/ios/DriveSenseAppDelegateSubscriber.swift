// Launch hook (design §2.4; rev1: I2, C2). Registered in expo-module.config.json →
// apple.appDelegateSubscribers.
//
// iOS relaunches a terminated app in the background for a significant-change or region event
// (launch option `.location`); the event itself is delivered to a location manager's delegate
// once one exists. So on every launch this creates the capture core — whose wake manager is that
// delegate — and re-attaches the wakes if armed. On a location relaunch with a capture still open
// (the process died mid-drive), full capture restarts at once, before JS has booted, under the
// watchdog's 60 s claim. The resulting `wake` is buffered until the JS listener attaches.
import ExpoModulesCore
import UIKit

public class DriveSenseAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let forLocation = launchOptions?[.location] != nil
    CaptureController.shared.launched(forLocation: forLocation)
    return true
  }
}
