package expo.modules.drivesense

import android.app.ActivityManager
import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.PowerManager
import androidx.core.content.ContextCompat

/**
 * Phone state while capturing (README §5): `locked = KeyguardManager.isKeyguardLocked`,
 * `screenOn = PowerManager.isInteractive`, `appForeground` from this process's importance.
 * Registered dynamically only while capturing — `SCREEN_ON`/`SCREEN_OFF`/`USER_PRESENT` emit
 * `screen`, the thermal listener (API 29+) emits `thermal`. Android's lock signal is `reliable`.
 */
class PhoneStateReceiver(private val context: Context, private val handler: Handler) : BroadcastReceiver() {
  companion object {
    fun locked(context: Context): Boolean =
      (context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager?)?.isKeyguardLocked ?: false

    fun screenOn(context: Context): Boolean =
      (context.getSystemService(Context.POWER_SERVICE) as PowerManager?)?.isInteractive ?: true

    fun appForeground(): Boolean {
      val info = ActivityManager.RunningAppProcessInfo()
      ActivityManager.getMyMemoryState(info)
      return info.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
    }

    /** NONE/LIGHT → nominal, MODERATE → fair, SEVERE → serious, CRITICAL and above → critical. */
    fun thermalLevel(status: Int): String = when {
      Build.VERSION.SDK_INT < Build.VERSION_CODES.Q -> "nominal"
      status >= PowerManager.THERMAL_STATUS_CRITICAL -> "critical"
      status >= PowerManager.THERMAL_STATUS_SEVERE -> "serious"
      status >= PowerManager.THERMAL_STATUS_MODERATE -> "fair"
      else -> "nominal"
    }

    fun thermalLevel(context: Context): String {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return "nominal"
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager? ?: return "nominal"
      return thermalLevel(pm.currentThermalStatus)
    }
  }

  private var registered = false
  private var thermalListener: Any? = null
  private var lastThermal: String? = null

  fun snapshot(): PhoneSample = PhoneSample(locked(context), screenOn(context), appForeground())

  fun register() {
    if (registered) return
    registered = true
    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_ON)
      addAction(Intent.ACTION_SCREEN_OFF)
      addAction(Intent.ACTION_USER_PRESENT)
    }
    // System broadcasts only; not exported to other apps.
    ContextCompat.registerReceiver(context, this, filter, null, handler, ContextCompat.RECEIVER_NOT_EXPORTED)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager?
      if (pm != null) {
        lastThermal = thermalLevel(pm.currentThermalStatus)
        val listener = PowerManager.OnThermalStatusChangedListener { status ->
          val level = thermalLevel(status)
          if (level != lastThermal) {
            lastThermal = level
            EventBus.emit("thermal", linkedMapOf("level" to level, "ts" to System.currentTimeMillis()))
          }
        }
        try {
          pm.addThermalStatusListener({ r -> handler.post(r) }, listener)
          thermalListener = listener
        } catch (_: Exception) {
          // no thermal service on this device: getThermalState still answers from currentThermalStatus
        }
      }
    }
  }

  fun unregister() {
    if (!registered) return
    registered = false
    try {
      context.unregisterReceiver(this)
    } catch (_: Exception) {
      // not registered
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val listener = thermalListener as? PowerManager.OnThermalStatusChangedListener
      if (listener != null) {
        try {
          (context.getSystemService(Context.POWER_SERVICE) as PowerManager?)?.removeThermalStatusListener(listener)
        } catch (_: Exception) {
          // already removed
        }
      }
    }
    thermalListener = null
  }

  override fun onReceive(ctx: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_SCREEN_ON, Intent.ACTION_SCREEN_OFF, Intent.ACTION_USER_PRESENT ->
        EventBus.emit(
          "screen",
          linkedMapOf("locked" to locked(context), "on" to screenOn(context), "ts" to System.currentTimeMillis())
        )
    }
  }
}
