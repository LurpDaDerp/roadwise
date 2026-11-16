package expo.modules.drivesense.detect

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import expo.modules.drivesense.CaptureEnd
import expo.modules.drivesense.CaptureService
import expo.modules.drivesense.DetectEventBus
import expo.modules.drivesense.DriveSensePrefs
import expo.modules.drivesense.RowJournal
import expo.modules.drivesense.RowJournalRead
import expo.modules.drivesense.RowsPage
import expo.modules.drivesense.WatchNotification
import java.io.File
import java.util.concurrent.Executors

/**
 * The drive detector on Android (the iOS `DriveDetector.swift`; the JS contract is
 * `src/detect/types.ts`). One per process ([get]), on one [HandlerThread]: every decision and every
 * field below runs there, so nothing is shared but the two `@Volatile` views ([recordingNow],
 * [liveDriveId]) other threads read. The row journal writes on its own single thread.
 *
 * off → armed (JS armed it, "Allow all the time" + Precise + Physical activity, Play services) →
 * candidate (a wake: an IN_VEHICLE ENTER, the parked geofence's exit, RoadWise coming to the front;
 * the watch after an automatic end; the Start card) → recording ⇄ ending (a JS end rule is overdue)
 * → armed; "Not driving?" → suppressed → armed. Every decision is [DetectPolicy]'s, with iOS's
 * numbers; this class reads the phone and acts. The wakes and the watch are in
 * DriveDetectorWatch.kt, the drive in DriveDetectorDrive.kt, the live motion feed and the rest in
 * DriveDetectorSensing.kt.
 *
 * Sensing is the location foreground service ([CaptureService]): a watch runs it in its watch form
 * (GPS, IMU and rows into the candidate's buffer, the silent "Checking for a drive" notification, no
 * JS), a drive in its drive form (rows journaled and handed to JS, the drive notification). A watch
 * starts from a wake's broadcast (Android 12+ lets an activity-transition or geofence broadcast
 * start a location service from the background, with "Allow all the time") or from RoadWise in
 * front; a confirmed watch becomes the drive in place (no gap), and an automatic end becomes the
 * linger's watch in place. A start Android refuses (ForegroundServiceStartNotAllowedException, or a
 * SecurityException on 14+) never loses a drive: its record and journal stay, and the next process
 * start or foreground resumes it or ends it. With nothing sensing, RoadWise uses no GPS: the wakes
 * are Play services' transitions and geofence, delivered to a stopped app.
 *
 * The record ([DriveDetectRecord]) is saved before each transition's side effects.
 */
class DriveDetector private constructor(context: Context) {
  companion object {
    private const val PREFS = "expo.modules.drivesense.detect"
    private const val KEY = "record"
    private const val HISTORY_KEY = "history"
    private val DRIVE_ID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

    @Volatile
    private var shared: DriveDetector? = null

    /** The process's detector, made on first use (the package's launch hook makes it first). */
    fun get(context: Context): DriveDetector =
      shared ?: synchronized(this) { shared ?: DriveDetector(context).also { shared = it } }

    /** The detector if this process made one; never makes one (the capture's rows, the activity feed). */
    fun peek(): DriveDetector? = shared

    /** A drive id names a file: a lowercase UUID and nothing else. */
    fun isDriveId(s: String): Boolean = DRIVE_ID.matches(s)

    fun now(): Double = System.currentTimeMillis().toDouble()
  }

  internal val app: Context = context.applicationContext
  private val thread = HandlerThread("drive-sense-detect").also { it.start() }
  internal val handler = Handler(thread.looper)
  /** Made on first use, off the main thread (`noBackupFilesDir` creates its directory). */
  internal val journal: RowJournal by lazy {
    RowJournal(
      File(app.noBackupFilesDir, "drivesense/journal"),
      Executors.newSingleThreadExecutor { r -> Thread(r, "drive-sense-journal") }
    )
  }
  internal val access = DriveDetectAccess(app)
  internal val wakes = WakeSources(app)
  private val store: SharedPreferences = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  // ——— detector thread only ———

  /** The record as saved (null: nothing stored yet). */
  internal var rec: DriveDetectRecord? = null

  /** This process senses the record's drive: its capture runs and its rows are journaled. */
  internal var sensing = false

  /** A Start-card drive waits for its foreground service. */
  internal var starting = false

  /** A resume reads the journal. */
  internal var resuming = false

  /** A resume Android refused to start sensing for: tried again at the next foreground or process start. */
  internal var resumePending = false

  internal var endClock = DetectPolicy.endClockAt(0.0)
  internal var nextSeq = 1L
  internal var lastRowTs: Double? = null
  internal var lastFix: LatLng? = null
  /** The standing confident walk's arrival (the safety stop's walking end, a watch's walking end); null: none. */
  internal var walkSince: Double? = null
  /** The standing live report is confident moving car motion (a fix-less row then holds the still clock). */
  internal var carStanding = false

  // The watch (DriveDetectorWatch.kt). Runtime only: a candidate never survives a process.

  /** This process runs the candidate's watch (its capture's rows come to [buffer]). */
  internal var watching = false
  internal val buffer = RowBuffer<Map<String, Any?>>()
  internal var confirmState = ConfirmState()
  internal var slowState = SlowTrafficState()
  /** The candidate is the watch after an automatic end: no hourly cap, rest or parked spot. */
  internal var lingering = false
  /** This candidate's last vehicle sign (a trusted row at 10 mph or more, unvetoed, or a confident automotive report). */
  internal var lastVehicleTs: Double? = null
  /** The standing live report is a confident automotive one (a car at a light too). */
  internal var vehicleStanding = false
  /** When confident moving car motion was last seen (a wake's motion history, the live feed); 0: never. */
  internal var lastCarMotionAt = 0.0
  /** The on-foot veto's memory. */
  internal var vetoState = VetoState()

  /** The motion history ([ActivityHistory]), loaded with the record. */
  internal var history: List<ActivityHistory.Entry> = emptyList()

  private val tickTask = Runnable { tick() }
  internal val restTask = Runnable { checkRest() }

  /** Play services dropped the parked geofence (location off): set again at the next foreground. */
  private var geofenceLost = false

  /** The record says a drive records (recording or ending): read by the capture and the module. */
  @Volatile
  var recordingNow = false
    private set

  @Volatile
  var liveDriveId: String? = null
    private set

  init {
    // The disk is read on the detector's thread, never the caller's (Application.onCreate is main).
    handler.post {
      DriveSensePrefs.init(app).forgetRetired()
      rec = DriveDetectRecord.fromJson(store.getString(KEY, null))
      history = ActivityHistory.decode(store.getString(HISTORY_KEY, null))
      view()
      WatchNotification.retireReminderChannel(app)
    }
  }

  internal val nativeBuild: String by lazy {
    try {
      val info = app.packageManager.getPackageInfo(app.packageName, 0)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode.toString() else @Suppress("DEPRECATION") info.versionCode.toString()
    } catch (_: Exception) {
      ""
    }
  }

  private fun view() {
    val r = rec
    recordingNow = r?.recording == true
    liveDriveId = if (r?.recording == true) r.driveId else null
  }

  internal fun save(r: DriveDetectRecord) {
    rec = r
    // commit: a process killed right after a transition must still find it.
    store.edit().putString(KEY, r.toJson()).commit()
    view()
  }

  /** The motion history with [added], stored (apply: it is rebuilt from new transitions if a kill loses the last write). */
  internal fun addHistory(added: List<ActivityHistory.Entry>, now: Double) {
    if (added.isEmpty()) return
    history = ActivityHistory.add(history, added, now)
    store.edit().putString(HISTORY_KEY, ActivityHistory.encode(history)).apply()
  }

  internal fun clearHistory() {
    history = emptyList()
    store.edit().remove(HISTORY_KEY).apply()
  }

  /** The motion history summarized from [from] to now (the policy's `summarize`). */
  internal fun motionSince(from: Double, now: Double): MotionSummary =
    DetectPolicy.summarize(ActivityHistory.samples(history, from), now)

  /** Detection may run: JS armed it for an owner, and its permissions and wakes are there. */
  internal fun allowed(r: DriveDetectRecord): Boolean = r.armed && r.ownerId != null && access.snapshot().requiredOk

  internal fun stateJson(reason: String? = null): Map<String, Any?> = (rec ?: DriveDetectRecord()).state(access.snapshot(), reason)

  /** Live only (DetectEventBus): JS reads the state with `getState`. */
  internal fun emitState(reason: String) {
    DetectEventBus.emitLive("detectState", stateJson(reason))
  }

  /** Back to armed (or off without the arming or the permissions); the drive's fields cleared. */
  internal fun settle(r: DriveDetectRecord, now: Double): DriveDetectRecord =
    r.copy(
      state = if (allowed(r)) "armed" else "off",
      origin = null,
      since = now,
      waitUntil = null,
      driveId = null,
      startedAt = null,
      startSource = null,
      suppressedSince = null,
      suppressedUntil = null,
      rest = RestStanding()
    )

  // ——— JS (each answers on the detector thread or the journal's) ———

  /** `setArmed`: JS's arming for an owner (a different owner forgets the last end), then [sync]. */
  fun setArmed(armed: Boolean, ownerId: String, done: (Map<String, Any?>) -> Unit) {
    handler.post {
      var r = rec ?: DriveDetectRecord()
      if (armed && r.ownerId != null && r.ownerId != ownerId) r = r.copy(lastEnd = null, parked = null)
      save(r.copy(armed = armed, ownerId = if (armed) ownerId else null))
      sync(if (armed) "armed" else "disarmed")
      done(stateJson())
    }
  }

  /** `getState`: the state now (a rest past its end ends first); the journal-dropped count is reported once. */
  fun getState(done: (Map<String, Any?>) -> Unit) {
    handler.post {
      checkRest()
      val out = stateJson()
      rec?.let { if (it.journalDropped > 0) save(it.copy(journalDropped = 0)) }
      done(out)
    }
  }

  /** The permissions may have changed (the "Always" request answered): the arming follows. */
  fun permissionsChanged() {
    handler.post { sync("permissionLost") }
  }

  /**
   * Brings the state in line with the arming and the permissions (Android tells no app when one is
   * revoked: this runs at every wake, foreground and arming). A drive in progress finishes first.
   * Armed again, the parked geofence goes back to the last end's place, as iOS's region does.
   */
  internal fun sync(reason: String) {
    val r = rec ?: return
    val ok = allowed(r)
    val now = now()
    when {
      r.state == "off" && ok -> {
        val spot = r.lastEnd?.let { LatLng(it.lat, it.lng) }
        save(r.copy(state = "armed", since = now, parked = spot))
        syncWakes()
        wakes.setParked(spot)
        emitState("armed")
        return
      }
      r.state == "armed" && !ok -> {
        save(r.copy(state = "off", since = now))
        emitState(if (r.armed) "permissionLost" else "disarmed")
      }
      r.state == "candidate" && r.origin != "manual" && !ok -> endCandidate(if (r.armed) "permissionLost" else "disarmed", rest = false)
      r.state == "suppressed" && !ok -> endSuppression()
      else -> Unit
    }
    syncWakes()
  }

  /**
   * The wakes run while detection is allowed and not off (armed, watching, recording, resting): the
   * transitions, the boot receiver and the parked geofence; otherwise all of them stop and the
   * parked spot is forgotten, as iOS's region is (arming again places it at the last end).
   */
  internal fun syncWakes(force: Boolean = false, onDone: () -> Unit = {}) {
    val r = rec
    val run = r != null && allowed(r) && r.state != "off"
    if (!run && r?.parked != null) save(r.copy(parked = null))
    wakes.sync(run, force, onDone)
  }

  /** The parked spot moves to [place]: kept (a reboot sets it again) and the geofence replaced. */
  internal fun park(place: LatLng) {
    val r = rec ?: return
    if (r.state == "off") return
    save(r.copy(parked = place))
    wakes.setParked(place)
  }

  /** A reboot or an app update dropped every registration ([expo.modules.drivesense.DetectBootReceiver]). */
  fun rearm(done: () -> Unit) {
    handler.post {
      if (rec == null) {
        done()
        return@post
      }
      sync("permissionLost")
      val r = rec
      if (r != null && r.state != "off") wakes.setParked(r.parked)
      syncWakes(force = true, onDone = done)
    }
  }

  /** Play services dropped the geofence (location switched off): it is set again when RoadWise next comes to the front. */
  fun onGeofenceLost() {
    handler.post { geofenceLost = true }
  }

  /**
   * `startWaiting`: the Start card. While Using and Precise are enough (RoadWise is in front, the
   * one moment Android lets a location foreground service start without "Allow all the time"). The
   * service goes first: the drive opens only once it runs, so a refusal leaves nothing behind. A
   * watch running gives way to it (its rows dropped; its service becomes the drive's).
   */
  fun startWaiting(done: (Map<String, Any?>) -> Unit) {
    handler.post {
      val p = access.snapshot()
      if (p.location == LocationAccess.NONE || !p.precise) {
        done(refusal("permission"))
        return@post
      }
      if (rec == null) save(DriveDetectRecord())
      val r = rec
      if (r == null) {
        done(refusal("unavailable"))
        return@post
      }
      if (r.recording || starting || resuming || CaptureService.plainCapturing()) {
        done(refusal("busy"))
        return@post
      }
      starting = true
      val tap = now()
      CaptureService.startDetector(app, RowJournalRead.jsMs(tap), "mounted", restart = false) { code ->
        handler.post {
          starting = false
          if (code != null) {
            done(refusal(if (code == "E_PERMISSION") "permission" else "unavailable"))
            return@post
          }
          beginManualDrive(tap)
          val n = rec
          val id = n?.driveId
          val startedAt = n?.startedAt
          val waitUntil = n?.waitUntil
          if (n == null || !n.recording || id == null || startedAt == null || waitUntil == null) {
            CaptureService.stopDetector(app, 0L)
            done(refusal("unavailable"))
          } else {
            done(linkedMapOf("ok" to true, "waitUntil" to RowJournalRead.jsMs(waitUntil), "driveId" to id, "startedAt" to RowJournalRead.jsMs(startedAt)))
          }
        }
      }
    }
  }

  private fun refusal(reason: String): Map<String, Any?> = linkedMapOf("ok" to false, "reason" to reason)

  /** `extendWaiting`: any touch while a Start-card drive waits for driving speed; the new deadline, or null. */
  fun extendWaiting(done: (Long?) -> Unit) {
    handler.post {
      val r = rec
      if (r == null || !r.recording || r.origin != "manual" || r.waitUntil == null) {
        done(null)
        return@post
      }
      val until = now() + DetectPolicy.WAIT_MAX_MS
      save(r.copy(waitUntil = until))
      emitState("extended")
      done(RowJournalRead.jsMs(until))
    }
  }

  /**
   * `cancelWaiting`: a manual candidate's wait ends. The Start card's drive opens at the tap, so
   * there is no such candidate to cancel (JS ends the drive itself); kept for the contract.
   */
  fun cancelWaiting(done: () -> Unit) {
    handler.post {
      val r = rec
      if (r != null && r.state == "candidate" && r.origin == "manual" && !starting) {
        save(settle(r, now()))
        emitState("cancelled")
      }
      done()
    }
  }

  /**
   * DriveSense `stopCapture` while a drive records: JS's end (its cut, else now). An end JS calls
   * automatic (`end.automatic`: the parking spot's, among others) or that a JS end rule would have
   * made by now was automatic: the watch lingers. False: no drive here (a plain capture's stop).
   */
  fun stopCapture(end: CaptureEnd?, done: (Boolean) -> Unit) {
    handler.post {
      if (rec?.recording == true) {
        commitEnd("js", end?.drivingEndedAt?.toDouble() ?: now(), linger = end?.automatic == true || automaticEndDue())
        done(true)
      } else {
        done(false)
      }
    }
  }

  /** `listDrives`: a file with no end that is not the live drive is listed as an orphan for JS to adopt. */
  fun listDrives(done: (List<Map<String, Any?>>) -> Unit) {
    handler.post {
      val r = rec
      RowJournalRead.list(journal, if (r?.recording == true) r.driveId else null, r != null, done)
    }
  }

  fun readRows(driveId: String, afterSeq: Long, limit: Int, done: (RowsPage) -> Unit) {
    val after = maxOf(0L, afterSeq)
    if (!isDriveId(driveId)) {
      done(RowsPage(emptyList(), after, true))
      return
    }
    RowJournalRead.read(journal, driveId, after, limit.coerceIn(1, DetectPolicy.READ_ROWS_MAX), done)
  }

  /** `discardDrive`: [done] true (busy) for the live drive; otherwise the file goes (or never was). */
  fun discardDrive(driveId: String, done: (Boolean) -> Unit) {
    handler.post {
      val r = rec
      when {
        r != null && r.recording && r.driveId == driveId -> done(true)
        !isDriveId(driveId) -> done(false)
        else -> journal.delete(driveId) { done(false) }
      }
    }
  }

  /**
   * `wipe` (a sign-out, a device or account switch): nothing of the last owner stays. A watch, a
   * drive or a rest stops (no `driveEnded`: JS ends its own drive first), every journal file goes,
   * the motion history and the parked spot go, the wakes stop, and the record starts again empty: no
   * owner, not armed, no last end, no rest, no drive, off.
   */
  fun wipe(done: () -> Unit) {
    handler.post {
      val waiting = rec?.state == "candidate" && rec?.origin == "manual"
      if (sensing || watching || rec?.recording == true) finishSensing(holdMs = 0L)
      stopClock()
      handler.removeCallbacks(restTask)
      starting = false
      resumePending = false
      nextSeq = 1
      lastRowTs = null
      lastFix = null
      walkSince = null
      carStanding = false
      clearWatch()
      lastCarMotionAt = 0.0
      vetoState = VetoState()
      save(DriveDetectRecord())
      clearHistory()
      wakes.setParked(null)
      syncWakes()
      clearStaleCapture()
      journal.wipe { done() }
      emitState(if (waiting) "cancelled" else "disarmed")
    }
  }

  /**
   * RoadWise came to the front (an activity started, or JS's `appForeground`): a drive whose resume
   * Android refused behind is resumed now (or ended, past its 5 min), a rest past its end ends, a
   * permission change is taken in, a geofence location-off dropped is set again, and then the `app`
   * wake: a watch opens when the motion history shows the car moving in the last 2 min and the
   * driver not on foot (the rest after an empty watch is skipped, never the hourly cap).
   */
  fun appForeground() {
    handler.post {
      val r = rec ?: return@post
      if (resumePending && !resuming && !sensing && r.recording) r.driveId?.let { resumeDrive(it) }
      checkRest()
      sync("permissionLost")
      if (geofenceLost && rec?.state != "off") {
        geofenceLost = false
        wakes.setParked(rec?.parked)
      }
      onWake(WakeReason.APP)
    }
  }

  // ——— the clock ———

  internal fun startClock() {
    handler.removeCallbacks(tickTask)
    handler.postDelayed(tickTask, DetectPolicy.TICK_MS.toLong())
  }

  internal fun stopClock() {
    handler.removeCallbacks(tickTask)
  }

  /** Every 5 s while a watch or a drive is sensed: a candidate's deadline, the safety stop when rows stall. */
  private fun tick() {
    val r = rec ?: return
    when {
      r.state == "candidate" && watching -> candidateTick(r, now())
      r.recording && sensing -> evaluateEnd()
      else -> return
    }
    val n = rec ?: return
    if ((n.state == "candidate" && watching) || (n.recording && sensing)) handler.postDelayed(tickTask, DetectPolicy.TICK_MS.toLong())
  }

  // ——— a new process ———

  /**
   * Every process start (DriveSensePackage) and the capture service's sticky restart. A candidate
   * never survives a process; a drive open in the last process resumes from its journal or ends as
   * an orphan; a rest goes on until its end (Android senses it through the transitions Play
   * services kept delivering, so nothing restarts its clocks). The wakes are synced (registrations
   * from an earlier boot are made again). Already sensing in this process: nothing to do.
   */
  fun resumeAtLaunch() {
    handler.post {
      if (sensing || resuming || starting || watching) return@post
      val r = rec
      if (r == null) {
        clearStaleCapture()
        CaptureService.releaseIfIdle()
        return@post
      }
      val now = now()
      when (r.state) {
        "candidate" -> save(settle(r, now))
        "recording", "ending" -> {
          val id = r.driveId
          if (id != null) {
            resumeDrive(id)
            syncWakes()
            return@post
          }
          save(settle(r, now))
          emitState("ended")
        }
        "suppressed" -> checkRest()
        else -> Unit
      }
      clearStaleCapture()
      CaptureService.releaseIfIdle()
      syncWakes()
    }
  }

  /** The capture-open flags a dead process left for a detector drive go, when nothing captures now. */
  internal fun clearStaleCapture() {
    if (CaptureService.isCapturing) return
    val prefs = DriveSensePrefs.init(app)
    if (prefs.detectorOwned) {
      prefs.detectorOwned = false
      prefs.captureOpen = false
    }
  }
}
