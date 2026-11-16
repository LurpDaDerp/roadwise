package expo.modules.drivesense.detect

import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The drive detector's rules on Android (plan §3.3, §3.4, §3.6, §3.7): the Kotlin port of
 * `src/detect/policy.ts`, constant for constant (`__tests__/native-android.test.ts` compares every
 * name and value with `DETECT`) and rule for rule, in the reference's order. It ports the
 * TypeScript, not the Swift: where they could differ, the reference wins. The shared decision table
 * (`src/detect/vectors.ts`) runs through these very functions on the phone ([DetectSelfTest], from
 * the Settings self-test) and on the JVM (`src/test`, over the generated
 * `src/test/resources/detect-vectors.json`).
 *
 * Pure: no android.*, androidx.* or org.json, no clock, no I/O. The detector runtime reads the phone
 * and acts; this decides. The rows, the wakes, the hourly cap, the launch and the status are here;
 * the confirmation and the start are in DetectStartPolicy.kt and the safety stop and the "Not
 * driving?" rest in DetectEndPolicy.kt, as extensions of this object, so every rule is called the
 * same way: `DetectPolicy.confirmStep(...)`.
 */
object DetectPolicy {
  const val MPS_PER_MPH = 0.44704

  // ——— The detector's numbers: same names, same values as `DETECT` in policy.ts ———

  /**
   * The auto trigger ([autoHoldMs]): the hold a speed needs is (5/3)·(30 − mph) s for a speed over
   * 15 mph, 5 s less for every 3 mph faster: 25 s just over 15 mph (AUTO_HOLD_MS_15, where the line
   * starts), 20 s at 18, 15 s at 21, 10 s at 24, 5 s at 27 and 0 at 30 mph (AUTO_INSTANT_MPS). The
   * hold never falls under AUTO_HOLD_MIN_MS, a GPS-spike guard: from about 29.46 mph a drive
   * confirms on the second good reading in a row, never on a single one. The floor sits a little
   * under the 1 s row interval, so two 1 Hz readings confirm whatever the timer's jitter (997 ms
   * apart, say). 15 mph and under earns nothing; under 20 mph only with fresh car motion.
   */
  const val AUTO_MIN_MPS = 6.7056
  const val AUTO_HOLD_MS_15 = 25_000.0
  const val AUTO_MPS_20 = 8.9408
  const val AUTO_INSTANT_MPS = 13.4112
  const val AUTO_HOLD_MIN_MS = 900.0
  /** Two readings further apart than this earn nothing for the interval between them (what was earned stays). */
  const val AUTO_ROW_GAP_MAX_MS = 2_000.0
  /** The evidence is forgotten after this long with no trusted reading over 3 mph (a stop that long ends a drive). */
  const val AUTO_FORGET_MS = 300_000.0
  /** A Start-card session: 10 mph held 15 s. */
  const val CONFIRM_MPS_MANUAL = 4.4704
  const val CONFIRM_HOLD_MS_MANUAL = 15_000.0
  /** A dip under the Start card's trigger (or an untrusted row) spanning this long or less keeps the hold. */
  const val CONFIRM_DIP_MAX_MS = 5_000.0
  /** A confident cycling, walking or running report this recent earns an auto candidate nothing, unless a confident automotive report came after it ([onFootVeto]). */
  const val VETO_FRESH_MS = 30_000.0
  /** A row counts only with a fix this accurate… */
  const val TRUSTED_HACC_M = 30.0
  /** …and a speed accuracy this good (or unrated). */
  const val TRUSTED_SPEED_ACC_MPS = 2.0
  /**
   * The slow-traffic confirmation ([slowTrafficStep]), beside the speed evidence: inside one
   * candidate, confident moving car motion standing 20 s in all, from at least two confident
   * automotive reports 10 s or more apart, with a confident automotive report (moving or standing)
   * standing for 80 % of the time since the first trusted row over 3 mph; a trusted path of 400 m
   * whose last fix is 200 m in a straight line from its first (each step at most 1.5 times what the
   * faster of its two rows could cover, plus 5 m); trusted rows over 3 mph averaging 10 mph; and no
   * confident walking, running or cycling report since the candidate opened.
   */
  const val SLOW_CAR_MS = 20_000.0
  const val SLOW_CAR_SPAN_MS = 10_000.0
  const val SLOW_CAR_COVER_MIN = 0.8
  const val SLOW_PATH_M = 400.0
  const val SLOW_NET_M = 200.0
  const val SLOW_AVG_MPS = 4.4704
  const val SLOW_STEP_SLACK = 1.5
  const val SLOW_STEP_PAD_M = 5.0
  /**
   * The car link start ([linkStep]): with a paired car's audio (or any CarPlay) current, two trusted
   * rows in a row at 5 mph or more, the candidate not marked on foot, each with fresh car motion;
   * with CarPlay current, at 15 mph or more without it too.
   */
  const val LINK_MIN_MPS = 2.2352
  const val LINK_NO_CAR_MPS = 6.7056
  const val LINK_PACE_ROWS = 2
  /** At most this many paired cars (family cars). */
  const val CARS_MAX = 3
  /** The outputs current for most of each of this many last drives are kept (JS's "Is <name> your car?"). */
  const val CAR_DRIVES_KEPT = 3
  /** "Most of a drive": current for more than this share of the drive's rows… */
  const val CAR_DRIVE_SHARE_MIN = 0.5
  /** …of a drive with at least this many rows (2 min) that reached driving speed. */
  const val CAR_DRIVE_MIN_ROWS = 120
  /** At most this many uids are remembered as "Not my car" (the oldest goes first). */
  const val CAR_NOT_MINE_MAX = 20
  /** 3 mph: "at or under 3 mph". */
  const val STOP_MPS = 1.34112
  /** 10 mph: a vehicle sign that keeps an auto candidate open. */
  const val MOVING_MPS = 4.4704
  /** 5 mph: movement for the still clock (two trusted rows in a row over it), and rolling before a stop (the trace-back). */
  const val MOVE_MPS = 2.2352
  const val MOVE_PACE_ROWS = 2
  /** Or a trusted fix this far from where the car went still. */
  const val MOVE_DISPLACEMENT_M = 100.0
  /** A stop shorter than this inside the rise is a red light, not the start. */
  const val TRACE_STOP_SPLIT_MS = 300_000.0
  /** The candidate's rolling buffer: 30 min at 1 Hz, the whole of the longest candidate. */
  const val CANDIDATE_BUFFER_MAX_ROWS = 1_800
  /** The parked spot is the motion start's place only when reachable at this speed, plus the slack. */
  const val PLAUSIBLE_MPS_MAX = 40.0
  const val PLAUSIBLE_SLACK_M = 300.0
  /** The wake gate: car motion this recent. */
  const val AUTOMOTIVE_FRESH_MS = 120_000.0
  /** The motion history read at a wake and for the back-fill. */
  const val MOTION_LOOKBACK_MS = 10_800_000.0
  /** Only this long without moving car motion starts a new car run. */
  const val MOTION_RUN_GAP_MS = 1_800_000.0
  /** An auto candidate ends after this long without a vehicle sign (AUTO_FORGET_MS once it holds evidence). */
  const val CANDIDATE_MAX_MS = 180_000.0
  /** An auto candidate ends after this long whatever it sees. */
  const val CANDIDATE_CAP_MS = 1_800_000.0
  /** After a candidate that saw no vehicle (or reached its cap), the resting wakes start none for this long. */
  const val CANDIDATE_REST_MS = 600_000.0
  /** At most this many candidates that saw no vehicle start in an hour. */
  const val CANDIDATES_PER_HOUR_MAX = 6
  const val HOUR_MS = 3_600_000.0
  /** The parked car's region (exit only), set where a drive ended: leaving it is a wake. */
  const val PARKED_REGION_RADIUS_M = 100.0
  /** The cached fix a significant-change start delivers at once is not a wake when older than this (iOS). */
  const val SLC_STALE_MS = 120_000.0
  /** A visit is a wake when it was left this recently (iOS). */
  const val VISIT_FRESH_MS = 600_000.0
  /** A wake's background work ends once a fix arrives or after this. */
  const val WAKE_TASK_MAX_MS = 25_000.0
  /** A drive's end runs inside background work this long, so JS can store it and post its recap. */
  const val END_TASK_MAX_MS = 25_000.0
  /** A relaunch resumes a journaled drive whose last row is this young. */
  const val RESUME_MAX_GAP_MS = 300_000.0
  /** A resumed drive's rows go on this many seqs past the journal's highest ([resumeSeq]). */
  const val RESUME_SEQ_GAP = 1_000
  /** The Start card's wait (reset by every touch). */
  const val WAIT_MAX_MS = 300_000.0
  /** [continuesFrom]: a traced start this soon after the last end's decision… */
  const val CONTINUE_GAP_MS = 300_000.0
  /** …and this close to where it ended. */
  const val CONTINUE_DIST_M = 150.0
  /** The JS still end (`IDLE_END_S`); the native safety stop adds the slack. */
  const val STILL_END_MS = 300_000.0
  /** An on-foot report standing this long stops an auto candidate and ends the "Not driving?" rest. */
  const val WALK_CONFIRM_MS = 20_000.0
  /** The JS walking end (`WALK_END_S`, from when the walk began); native's walk standing this long. */
  const val WALK_END_MS = 10_000.0
  /** The JS walking end never fires before the report has stood this long (`WALK_STAND_MIN_S`). */
  const val WALK_STAND_MIN_MS = 3_000.0
  /** A fix over 3 mph this recent says the car is still driving: no walking end. */
  const val WALK_STALE_FIX_MS = 15_000.0
  const val END_CRAWL_MPS = 1.34112
  /** 5 mph: a walker's own pace tops out here (JS's walking end lets a carried phone this slow end a drive). */
  const val WALKER_PACE_MAX_MPS = 2.2352
  /** The native safety stop fires only this long after the JS still end or 12 h cap would have (`END_NATIVE_SLACK_S`)… */
  const val SAFETY_SLACK_MS = 60_000.0
  /** …and this long after the JS walking end would have (`END_NATIVE_WALK_SLACK_S`). */
  const val WALK_SAFETY_SLACK_MS = 10_000.0
  /**
   * The JS step walk (`motion.ts`): this many steps on the pedometer… (20 in 20 s is 60 steps a
   * minute, the floor of a slow walk's cadence; fidgeting in a seat steps slower.)
   */
  const val STEP_WALK_MIN = 20
  /** …within this long… */
  const val STEP_WINDOW_MS = 20_000.0
  /** …with no trusted fix over 3 mph in this long. */
  const val STEP_CALM_MS = 15_000.0
  /** The JS car-link end: the paired car gone this long, continuously, with no trusted fix over 3 mph since. */
  const val CAR_GONE_MS = 15_000.0
  /** A fix-less stretch with car motion pauses the still clock, at most this long. */
  const val FIXLESS_HOLD_MAX_MS = 3_600_000.0
  const val ROW_MS = 1_000.0
  /** 12 h: the cap on a drive. */
  const val MAX_DRIVE_MS = 43_200_000.0
  /** "Not driving?": detection rests at most this long… */
  const val SUPPRESS_MAX_MS = 10_800_000.0
  /** …and ends once nothing has moved over 3 mph for this long. */
  const val SUPPRESS_STILL_MS = 300_000.0
  const val JOURNAL_SYNC_EVERY_ROWS = 30
  /** A drive's file: 12 h and a minute of rows (about 650 bytes each as native writes them) fit with room. */
  const val JOURNAL_MAX_BYTES_PER_DRIVE = 33_554_432L
  const val JOURNAL_MAX_DRIVES = 4
  /** `readRows` returns at most this many rows a call. */
  const val READ_ROWS_MAX = 600
  /** The detector's clock while it senses. */
  const val TICK_MS = 5_000.0
  /** The "Recording your drive" note goes up only when no drive notification runs this long after the confirmation. */
  const val FALLBACK_NOTE_DELAY_MS = 20_000.0
  const val EARTH_RADIUS_M = 6_371_000.0

  // ——— Rows ———

  /** A fix the detector believes: valid, within 30 m, speed rated 2 m/s or better (or unrated), speed known. */
  fun trusted(r: DetectRow): Boolean =
    r.gnssValid &&
      r.hAcc >= 0 &&
      r.hAcc <= TRUSTED_HACC_M &&
      (r.speedAcc < 0 || r.speedAcc <= TRUSTED_SPEED_ACC_MPS) &&
      r.speed >= 0

  /** Trusted and at or under 3 mph. */
  fun slow(r: DetectRow): Boolean = trusted(r) && r.speed <= STOP_MPS

  /** Trusted and at 10 mph or more. */
  fun moving(r: DetectRow): Boolean = trusted(r) && r.speed >= MOVING_MPS

  /** Trusted and at 5 mph or more: the car rolling before a stop (the trace-back). */
  fun rolling(r: DetectRow): Boolean = trusted(r) && r.speed >= MOVE_MPS

  /** Great-circle metres (haversine). */
  fun distanceM(a: GeoPoint, b: GeoPoint): Double {
    val rad = PI / 180
    val sLat = sin(((b.lat - a.lat) * rad) / 2)
    val sLng = sin(((b.lng - a.lng) * rad) / 2)
    val h = sLat * sLat + cos(a.lat * rad) * cos(b.lat * rad) * sLng * sLng
    return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(h)))
  }

  // ——— Wakes ———

  /** Each sample lasts until the next starts (the newest until now); only 30 min without car motion starts a new run. */
  fun summarize(list: List<ActivitySample>, now: Double): MotionSummary {
    // sortedBy is stable, as Array.prototype.sort is: samples starting together keep their order.
    val sorted = list.sortedBy { it.start }
    var lastAutomotiveAt = 0.0
    var automotiveSince = 0.0
    var onFootNow = false
    sorted.forEachIndexed { i, a ->
      val end = if (i + 1 < sorted.size) sorted[i + 1].start else now
      onFootNow = a.onFoot && a.confident
      if (a.automotive && !a.stationary && a.confident) {
        if (automotiveSince == 0.0 || a.start - lastAutomotiveAt >= MOTION_RUN_GAP_MS) automotiveSince = a.start
        lastAutomotiveAt = end
      }
    }
    return MotionSummary(lastAutomotiveAt, automotiveSince, onFootNow)
  }

  /** A resting wake starts a candidate only on car motion from the last 2 min, the driver not on foot. */
  fun motionGate(m: MotionSummary, now: Double): MotionGate {
    if (m.lastAutomotiveAt <= 0 || now - m.lastAutomotiveAt > AUTOMOTIVE_FRESH_MS) return MotionGate.NOT_FRESH
    if (m.onFootNow) return MotionGate.ON_FOOT
    return MotionGate.OK
  }

  /** Candidate starts within the last hour. */
  fun recentStarts(starts: List<Double>, now: Double): List<Double> = starts.filter { t -> t <= now && now - t < HOUR_MS }

  /**
   * The cheap checks a wake passes before any motion query or GPS, in order. A region exit and
   * RoadWise coming to the front ignore the rest.
   */
  fun wakeGate(c: WakeCtx): WakeGate {
    if (!c.armed) return WakeGate.OFF
    if (!c.hasOwner) return WakeGate.NO_OWNER
    if (!c.permissionsOk) return WakeGate.PERMISSION
    if (c.phase != DetectPhase.ARMED) return WakeGate.BUSY
    if (c.reason != WakeReason.REGION && c.reason != WakeReason.APP && c.now < c.candidateRestUntil) return WakeGate.RESTING
    if (recentStarts(c.candidateStarts, c.now).size >= CANDIDATES_PER_HOUR_MAX) return WakeGate.CAPPED
    return WakeGate.OK
  }

  /**
   * A candidate's own clock. An auto one ends at its 30 min cap; 3 min after its last vehicle sign
   * (a trusted row at 10 mph or more with no fresh veto, or a confident automotive report), or after
   * it opened when it has seen none, 5 min once it holds evidence (speed evidence, or slow-traffic car
   * motion: [slowTrafficHeld]; a long light in a jam keeps it); or on a walk standing 20 s. A
   * Start-card one ends at its wait.
   */
  fun candidateDue(
    kind: TriggerKind,
    since: Double,
    waitUntil: Double?,
    walkSince: Double?,
    now: Double,
    lastVehicleTs: Double? = null,
    hasEvidence: Boolean = false
  ): CandidateCause? {
    if (kind == TriggerKind.MANUAL) return if (waitUntil != null && now >= waitUntil) CandidateCause.WAIT_TIMEOUT else null
    if (now - since >= CANDIDATE_CAP_MS) return CandidateCause.CAP
    if (now - maxOf(since, lastVehicleTs ?: since) >= (if (hasEvidence) AUTO_FORGET_MS else CANDIDATE_MAX_MS)) return CandidateCause.TIMEOUT
    if (walkSince != null && now - walkSince >= WALK_CONFIRM_MS) return CandidateCause.WALKING
    return null
  }

  /**
   * The hourly cap's record once a candidate is over: one that saw a vehicle (it confirmed, or it
   * watched a vehicle and did not) leaves it, its start (`since`) dropped; only empty ones count.
   */
  fun startsAfter(starts: List<Double>, since: Double, sawVehicle: Boolean): List<Double> =
    if (sawVehicle) starts.filter { t -> t != since } else starts.toList()

  // ——— Launch ———

  /** A relaunch resumes a journaled drive whose last row (else its start) is 5 min old or less; older ones end as orphans. */
  fun resumeDecision(lastRowTs: Double?, startedAt: Double, now: Double): ResumeDecision =
    if (now - (lastRowTs ?: startedAt) <= RESUME_MAX_GAP_MS) ResumeDecision.RESUME else ResumeDecision.ORPHAN

  /**
   * A resumed drive's rows go on after this seq: the journal's highest (`topSeq`: its last row's, or
   * an earlier resume's reservation) plus RESUME_SEQ_GAP. A power loss, or a kill with rows still
   * queued for the file, loses the rows the journal had not synced (at most 30, plus the write queue),
   * and JS may already hold them: resuming right after the durable seq would hand their seqs out
   * again and JS would drop the new rows as repeats. The `gap` line carries it, so a reader goes on
   * from it.
   */
  fun resumeSeq(topSeq: Long): Long = topSeq + RESUME_SEQ_GAP

  // ——— Status ———

  /**
   * `OFF` when JS has not armed it; `UNAVAILABLE` without the hardware; `NEEDS` when Location Always,
   * Precise Location or the motion permission is missing (detection stays off) or the background
   * allowance is off (detection runs, but the phone may not wake RoadWise), with `missing` in that
   * order plus the drive notification when it is off too; else `ON`. `requiredOk`: the three that
   * arming needs.
   */
  fun statusOf(p: StatusInputs): DetectStatusResult {
    val required = ArrayList<DetectMissing>()
    if (p.location != LocationAccess.ALWAYS) required.add(DetectMissing.LOCATION_ALWAYS)
    if (!p.precise) required.add(DetectMissing.LOCATION_PRECISE)
    if (p.motion != MotionAccess.GRANTED) required.add(DetectMissing.MOTION)
    val requiredOk = p.hardware && required.isEmpty()
    if (!p.armed) return DetectStatusResult(DetectStatus.OFF, emptyList(), requiredOk)
    if (!p.hardware) return DetectStatusResult(DetectStatus.UNAVAILABLE, emptyList(), requiredOk)
    val refreshOff = p.backgroundRefresh != BackgroundRefresh.AVAILABLE
    if (required.isEmpty() && !refreshOff) return DetectStatusResult(DetectStatus.ON, emptyList(), requiredOk)
    val missing = ArrayList<DetectMissing>(required)
    if (refreshOff) missing.add(DetectMissing.BACKGROUND_REFRESH)
    if (!p.liveActivities) missing.add(DetectMissing.LIVE_ACTIVITIES)
    return DetectStatusResult(DetectStatus.NEEDS, missing, requiredOk)
  }
}
