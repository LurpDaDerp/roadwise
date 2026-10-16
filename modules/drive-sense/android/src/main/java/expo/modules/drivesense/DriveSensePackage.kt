package expo.modules.drivesense

import android.app.Application
import android.content.Context
import expo.modules.core.interfaces.ApplicationLifecycleListener
import expo.modules.core.interfaces.Package

/**
 * drive-sense's Expo package (found by autolinking: a `*Package.kt` importing the Package
 * interface). Its one job: register [AppVisibility] from `Application.onCreate`, before any
 * activity starts, so the rows' `appForeground` counts every started RoadWise activity.
 */
class DriveSensePackage : Package {
  override fun createApplicationLifecycleListeners(context: Context): List<ApplicationLifecycleListener> =
    listOf(
      object : ApplicationLifecycleListener {
        override fun onCreate(application: Application) {
          AppVisibility.register(application)
        }
      }
    )
}
