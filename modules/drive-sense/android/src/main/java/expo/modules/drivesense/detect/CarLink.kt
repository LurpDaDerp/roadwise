package expo.modules.drivesense.detect

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.util.Log
import androidx.core.content.ContextCompat

/**
 * The car link on Android (the iOS `CarLink.swift`; the rules and the record are
 * [CarLinkRecord.kt]): which Bluetooth audio outputs and whether Android Auto are connected now, the
 * cars the driver paired, and what each drive saw. Read-only: it lists AudioManager's output
 * devices and hears their changes (an [AudioDeviceCallback]), and asks Android Auto whether it is
 * projecting; it never routes audio, starts SCO, sets a communication device or touches a
 * connection, so nothing of the driver's audio, calls or connections moves.
 *
 * - **Bluetooth outputs**: A2DP (`bluetoothA2DP`) and SCO, Android's HFP output (`bluetoothHFP`),
 *   matched on the device's Bluetooth address. LE audio outputs and hearing aids are never listed,
 *   as on iPhone (an LE audio output is a hearing aid or earbuds, never a car). Android lists every
 *   connected output, not only the one playing now, so a car connected for calls only shows too.
 *   Android 14+ hides the address from an app without Nearby devices (BLUETOOTH_CONNECT), which
 *   RoadWise asks for before "Use this car" (ruling 14); [CarLinkRules.reconcile] keeps one uid per
 *   car across the two forms. Android 7 to 8.1 report no address: the bonded device of that name
 *   gives it, else the name itself is the uid.
 * - **Android Auto** (iOS's CarPlay, `carAudio`, uid [ANDROID_AUTO_UID], named "Android Auto"):
 *   androidx.car.app's CarConnection contract, read without the library (its LiveData, its main
 *   thread and its Guava are not needed for one number): Android Auto's content provider answers the
 *   connection type, and its broadcast says when it changes. Projection (2) is connected; anything
 *   else, no provider (Android Auto not installed) or no answer, is not.
 *
 * The record (its own preferences file, JSON) holds at most CARS_MAX paired cars, the outputs
 * connected for most of each of the last CAR_DRIVES_KEPT drives that reached driving speed (JS's "Is
 * <name> your car?") and the uids the driver said are not their car; the detector reads it with no
 * JS, a new process keeps it, and [wipe] (sign-out, account switch) empties it. Pairing happens only
 * from the driver's tap in JS, never silently. Everything here runs on the detector's thread
 * ([handler]): the device callback and the Android Auto receiver are registered on it.
 */
internal class CarLink(context: Context, private val handler: Handler, private val onChange: () -> Unit) {
  companion object {
    private const val PREFS = "expo.modules.drivesense.carLink"
    private const val KEY = "record"
    private const val TAG = "DriveSense"
    const val ANDROID_AUTO_UID = "android-auto"
    const val ANDROID_AUTO_NAME = "Android Auto"
    /** androidx.car.app 1.7.0 CarConnection: ACTION_CAR_CONNECTION_UPDATED, CAR_CONNECTION_STATE, its provider and CONNECTION_TYPE_PROJECTION. */
    const val CAR_CONNECTION_UPDATED = "androidx.car.app.connection.action.CAR_CONNECTION_UPDATED"
    private const val CAR_CONNECTION_STATE = "CarConnectionState"
    private val CAR_CONNECTION_URI: Uri = Uri.Builder().scheme("content").authority("androidx.car.app.connection").build()
    private const val CONNECTION_TYPE_PROJECTION = 2

    /** Bluetooth addresses are readable in full: below Android 12 always; from 12 with Nearby devices (BLUETOOTH_CONNECT). */
    fun addressesReadable(context: Context): Boolean =
      Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
        ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
  }

  private val app = context.applicationContext
  private val store = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
  private val audio: AudioManager? = app.getSystemService(AudioManager::class.java)

  /** The Bluetooth and Android Auto outputs as last read. */
  var current: List<CarOutput> = emptyList()
    private set
  var rec = CarLinkRecord()
    private set
  /** A paired car or Android Auto is connected (`DetectPolicy.carLinked`). */
  var linked = false
    private set
  /** When the link last went away; null while it is up, and from each drive's start until it drops. */
  private var unlinkedSince: Double? = null
  /** The live drive: its tally, and whether the link was up during it. */
  private var driving = false
  private var tally = CarTally()
  private var linkedThisDrive = false
  /** Android Auto projects now (its provider's last answer). */
  private var projecting = false
  private var started = false

  private val devices = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>?) = refresh()
    override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>?) = refresh()
  }

  /** Android Auto's broadcast carries nothing read: it only says to ask its provider again. */
  private val androidAuto = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action != CAR_CONNECTION_UPDATED) return
      readProjection()
      refresh()
    }
  }

  /** Once per process, on the detector's thread: the record, then the outputs, then their changes. */
  fun start() {
    if (started) return
    started = true
    rec = CarLinkRecord.fromJson(store.getString(KEY, null)) ?: CarLinkRecord()
    try {
      // Android Auto (another app) sends it: exported, as CarConnection registers it. It starts
      // nothing; a spoofed one only makes RoadWise ask Android Auto's provider again.
      ContextCompat.registerReceiver(app, androidAuto, IntentFilter(CAR_CONNECTION_UPDATED), null, handler, ContextCompat.RECEIVER_EXPORTED)
    } catch (e: Exception) {
      Log.w(TAG, "android auto receiver not registered: ${e.javaClass.simpleName}")
    }
    readProjection()
    try {
      // Calls onAudioDevicesAdded with every output connected now, then each change, on [handler].
      audio?.registerAudioDeviceCallback(devices, handler)
    } catch (e: Exception) {
      Log.w(TAG, "audio device callback not registered: ${e.javaClass.simpleName}")
    }
    refresh(force = true)
  }

  private fun save() {
    store.edit().putString(KEY, rec.toJson()).apply()
  }

  /** Android Auto's connection type, asked of its provider (an IPC; this thread, never main). */
  private fun readProjection() {
    projecting = try {
      app.contentResolver.query(CAR_CONNECTION_URI, arrayOf(CAR_CONNECTION_STATE), null, null, null)?.use { c ->
        val i = c.getColumnIndex(CAR_CONNECTION_STATE)
        i >= 0 && c.moveToNext() && c.getInt(i) == CONNECTION_TYPE_PROJECTION
      } ?: false
    } catch (_: Exception) {
      false
    }
  }

  /** The connected Bluetooth and Android Auto outputs, read and nothing else. */
  private fun read(): List<CarOutput> {
    val raw = mutableListOf<CarOutput>()
    val outputs = try {
      audio?.getDevices(AudioManager.GET_DEVICES_OUTPUTS) ?: emptyArray()
    } catch (_: Exception) {
      emptyArray()
    }
    for (d in outputs) {
      val type = portType(d.type) ?: continue
      val name = d.productName?.toString()?.trim().orEmpty()
      val uid = uidOf(d, name) ?: continue
      raw.add(CarOutput(uid, name, type))
    }
    if (projecting) raw.add(CarOutput(ANDROID_AUTO_UID, ANDROID_AUTO_NAME, "carAudio"))
    return CarOutputs.normalize(raw)
  }

  /** A2DP and SCO (HFP) only: never LE audio (headsets, speakers, broadcast) or a hearing aid. */
  private fun portType(type: Int): String? = when (type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP -> "bluetoothA2DP"
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> "bluetoothHFP"
    else -> null
  }

  /** The device's Bluetooth address (Android 9+), else the bonded device of that name's, else its name. */
  @SuppressLint("MissingPermission")
  private fun uidOf(d: AudioDeviceInfo, name: String): String? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return d.address?.trim()?.takeIf { it.isNotEmpty() }?.let(CarUids::normalize)
    if (name.isEmpty()) return null
    val bonded = try {
      app.getSystemService(BluetoothManager::class.java)?.adapter?.bondedDevices?.filter { it.name == name }?.map { it.address }.orEmpty()
    } catch (_: Exception) {
      emptyList()
    }
    return bonded.singleOrNull()?.let(CarUids::normalize) ?: "name:$name"
  }

  /**
   * Reads the outputs against the record ([CarLinkRules.reconcile]: a full address replaces its
   * hidden form, a paired car takes its newest name). The link going away dates `unlinkedSince`;
   * coming back clears it (a flap leaves nothing behind).
   */
  fun refresh(force: Boolean = false) {
    if (!started) return
    val (next, r) = CarLinkRules.reconcile(read(), rec)
    var changed = force || next != current
    current = next
    if (r != rec) {
      rec = r
      save()
      changed = true
    }
    val was = linked
    linked = CarLinkRules.linked(next, rec)
    if (linked) {
      unlinkedSince = null
      if (driving) linkedThisDrive = true
    } else if (was) {
      unlinkedSince = DriveDetector.now()
    }
    if (changed || was != linked) onChange()
  }

  /**
   * For the car-link end: since when the link has been gone, continuously, during a drive that had
   * it; null while a paired car or Android Auto is connected, outside a drive, or when the link was
   * never up during this one. A flap (gone, back within seconds) clears it.
   */
  val goneSince: Double? get() = if (driving && linkedThisDrive && !linked) unlinkedSince else null

  /** Whether [address] (a Bluetooth device that just connected) is a paired car. */
  fun isPaired(address: String): Boolean {
    val a = CarUids.normalize(address)
    return rec.cars.any { CarUids.same(it.uid, a) }
  }

  fun hasCars(): Boolean = rec.cars.isNotEmpty()

  // ——— drives ———

  /** A drive begins (or resumes in a new process): its tally starts empty. */
  fun beginDrive() {
    refresh()
    driving = true
    tally = CarTally()
    linkedThisDrive = linked
    unlinkedSince = null
  }

  /** One live row of the drive: each connected output counts it. */
  fun countRow() {
    if (driving) tally.count(current)
  }

  /**
   * The drive ended. One that reached driving speed ([drove]) and ran 2 min or more keeps the
   * outputs connected for most of its rows, the newest CAR_DRIVES_KEPT; "Not driving?" keeps nothing.
   */
  fun endDrive(driveId: String, endedAt: Double, drove: Boolean) {
    val kept = if (driving) CarLinkRules.endDrive(rec, driveId, endedAt, tally, drove) else null
    driving = false
    tally = CarTally()
    linkedThisDrive = false
    unlinkedSince = null
    if (kept == null) return
    rec = kept
    save()
    onChange()
  }

  // ——— JS (the driver's taps) ———

  fun pair(uid: String): Map<String, Any?> {
    refresh()
    val next = CarLinkRules.pair(rec, current, uid, DriveDetector.now())
    if (next != rec) {
      rec = next
      save()
      refresh(force = true)
    }
    return json()
  }

  fun forget(uid: String): Map<String, Any?> {
    rec = CarLinkRules.forget(rec, uid)
    save()
    refresh(force = true)
    return json()
  }

  fun notMine(uid: String): Map<String, Any?> {
    rec = CarLinkRules.notMine(rec, uid)
    save()
    refresh(force = true)
    return json()
  }

  /** The sign-out and account-switch wipe: no paired car, drive seen or "not my car" stays. */
  fun wipe() {
    rec = CarLinkRecord()
    store.edit().remove(KEY).apply()
    driving = false
    tally = CarTally()
    linkedThisDrive = false
    unlinkedSince = null
    refresh(force = true)
  }

  /** The outputs read now, then the state. */
  fun state(): Map<String, Any?> {
    refresh()
    return json()
  }

  fun json(): Map<String, Any?> = CarLinkRules.state(current, rec, linked, goneSince)
}
