package expo.modules.drivesense

import android.app.Application
import android.content.Context
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package
import expo.modules.drivesense.detect.DriveDetector

/**
 * drive-sense's Expo package (found by autolinking: a `*Package.kt` importing the Package
 * interface). From `Application.onCreate`, before any activity starts, in every process:
 * - registers [AppVisibility], so the rows' `appForeground` counts every started RoadWise activity
 *   (and RoadWise coming to the front reaches the drive detector);
 * - hands the process to the drive detector ([DriveDetector.resumeAtLaunch]): a drive the last
 *   process left open resumes from its journal (its last row 5 min old or less) or ends as an orphan
 *   for JS to adopt, whatever started this process (RoadWise opened, the system's sticky restart, a
 *   broadcast). The detector works on its own thread: nothing here touches the disk.
 */
class DriveSensePackage : Package {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> =
    listOf(
      object : ApplicationLifecycleListener {
        override fun onCreate(application: Application) {
          AppVisibility.register(application)
          try {
            DriveDetector.get(application).resumeAtLaunch()
          } catch (_: Exception) {
            // no detector in this process: the next process start or the module's first call tries again
          }
        }
      }
    )
}
