package expo.modules.drivesense

import android.content.pm.ServiceInfo

/**
 * Whether Android ignored the location service's `startForeground` without throwing (pure: the
 * JVM tests hold it; [CaptureService.goForeground] reads the phone). With battery use Restricted,
 * Android lets a wake's broadcast start the service but then suppresses its `startForeground`
 * ("not allowed due to bg restriction"): no exception, no notification, and the service never
 * becomes a foreground one. On Android 10+ that shows as the service's foreground type still
 * none ([ServiceInfo.FOREGROUND_SERVICE_TYPE_NONE]) right after the call, as a foreground service
 * always has the location type; on Android 9, which has no such read, as Restricted with no
 * RoadWise screen open (a screen open keeps today's answer there). Below 9 Android never does it.
 */
object ForegroundRules {
  /**
   * [sdk]: `Build.VERSION.SDK_INT`. [type]: the service's foreground type after the call (Android
   * 10+; ignored below). [restricted]: battery use Restricted (`ActivityManager.isBackgroundRestricted`).
   * [visible]: a RoadWise activity is started.
   */
  fun suppressed(sdk: Int, type: Int, restricted: Boolean, visible: Boolean): Boolean =
    restricted &&
      when {
        sdk >= 29 -> type == ServiceInfo.FOREGROUND_SERVICE_TYPE_NONE
        sdk == 28 -> !visible
        else -> false
      }
}
