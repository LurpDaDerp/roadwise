package expo.modules.drivesense

import android.content.Context
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build

/**
 * `audioOutputState()` (README §2): what a DashPal alert would play into right now, read fresh on
 * each call (sync, no permission).
 *
 * - `callActive`: [PhoneStateReceiver.callState] (ringing, in a call, or a VoIP call using the
 *   microphone), the one Kotlin reading of the call state.
 * - `volume`: the media stream expo-audio plays alerts on (`STREAM_MUSIC`), 0-1; 0 while it is
 *   muted; null when it cannot be read.
 * - `headphones`: a wired headset or headphones, a USB headset or (API 31+) an LE-audio headset is
 *   an output; Bluetooth A2DP (a car, earbuds) and hearing aids are not (they are heard); null when
 *   the outputs cannot be read.
 */
object AudioOutput {
  fun state(context: Context): Map<String, Any?> {
    val am = try {
      context.getSystemService(Context.AUDIO_SERVICE) as AudioManager?
    } catch (_: Exception) {
      null
    }
    return linkedMapOf(
      "callActive" to (PhoneStateReceiver.callState(context) != null),
      "volume" to volume(am),
      "headphones" to headphones(am)
    )
  }

  private fun volume(am: AudioManager?): Double? {
    if (am == null) return null
    return try {
      if (am.isStreamMute(AudioManager.STREAM_MUSIC)) {
        0.0
      } else {
        val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
        if (max <= 0) null else (am.getStreamVolume(AudioManager.STREAM_MUSIC).toDouble() / max).coerceIn(0.0, 1.0)
      }
    } catch (_: Exception) {
      null
    }
  }

  private fun headphones(am: AudioManager?): Boolean? {
    if (am == null) return null
    return try {
      am.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { d ->
        d.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
          d.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
          d.type == AudioDeviceInfo.TYPE_USB_HEADSET ||
          (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && d.type == AudioDeviceInfo.TYPE_BLE_HEADSET)
      }
    } catch (_: Exception) {
      null
    }
  }
}
