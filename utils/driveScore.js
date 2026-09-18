// Per-drive score (0..100) and rule-based improvement tips, computed locally so
// the post-drive summary is instant and works offline. Weights are deliberately
// simple and documented here; the AI feedback remains the "coach" view.

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// metrics: the drive record (see docs/UX_REWORK.md §7). All fields optional.
export function scoreDrive(metrics = {}) {
  const durationMin = Math.max(1, (Number(metrics.duration) || 0) / 60);
  const per10 = (n) => (Number(n) || 0) / (durationMin / 10); // events per 10 minutes

  // Focus: phone use, phone pickups and monitoring eyes-off-road.
  let focus = 100;
  focus -= Math.min(60, (Number(metrics.phoneUsageTime) || 0) * 2); // 2 pts per second on the phone
  focus -= Math.min(30, (Number(metrics.distracted) || 0) * 10);    // 10 pts per pickup
  const mon = metrics.monitoring;
  if (mon && mon.enabled) {
    focus -= Math.min(40, (Number(mon.eyesOffRoadSeconds) || 0) * 0.8);
    const counts = mon.alertCounts || {};
    focus -= Math.min(30, (Number(counts.warning) || 0) * 3 + (Number(counts.critical) || 0) * 10);
  }
  focus = clamp(Math.round(focus), 0, 100);

  // Speed: speeding events and average margin over the limit.
  let speed = 100;
  speed -= Math.min(50, per10(metrics.speedingEvents) * 12);
  speed -= Math.min(40, (Number(metrics.avgSpeedingMargin) || 0) * 3);
  speed = clamp(Math.round(speed), 0, 100);

  // Smoothness: hard brakes and hard accelerations.
  let smooth = 100;
  smooth -= Math.min(50, per10(metrics.suddenStops) * 8);
  smooth -= Math.min(50, per10(metrics.suddenAccelerations) * 6);
  smooth = clamp(Math.round(smooth), 0, 100);

  const total = clamp(Math.round(focus * 0.5 + speed * 0.3 + smooth * 0.2), 0, 100);
  return { score: total, breakdown: { focus, speed, smoothness: smooth } };
}

export function scoreLabel(score) {
  const s = Number(score) || 0;
  if (s >= 90) return 'Excellent';
  if (s >= 75) return 'Good';
  if (s >= 55) return 'Fair';
  return 'Needs work';
}

// Up to `max` tips ordered by impact. Returns [{ icon, title, body }].
export function getDriveTips(metrics = {}, max = 3) {
  const tips = [];
  const push = (weight, icon, title, body) => tips.push({ weight, icon, title, body });
  const durationMin = Math.max(1, (Number(metrics.duration) || 0) / 60);

  const pickups = Number(metrics.distracted) || 0;
  const phoneSec = Math.round(Number(metrics.phoneUsageTime) || 0);
  if (pickups > 0 || phoneSec > 0) {
    push(
      100 + pickups * 10 + phoneSec,
      'phone-portrait-outline',
      pickups === 1 ? 'You picked up the phone once' : `You picked up the phone ${pickups} times`,
      phoneSec > 0
        ? `About ${phoneSec} seconds away from the road. Mount the phone and let RoadWise read the road for you.`
        : 'Even a glance away breaks the streak. Keep the phone mounted for the whole drive.'
    );
  }

  const mon = metrics.monitoring;
  if (mon && mon.enabled) {
    const off = Math.round(Number(mon.eyesOffRoadSeconds) || 0);
    const crit = Number(mon.alertCounts?.critical) || 0;
    const byType = mon.alertsByType || {};
    if (crit > 0) {
      push(95 + crit * 10, 'eye-off-outline', `${crit} critical alert${crit === 1 ? '' : 's'}`,
        'Long eyes-off-road or drowsiness moments. Take a break before the next long drive.');
    } else if (off >= 10) {
      push(80 + off, 'eye-off-outline', `${off} s with eyes off the road`,
        'Short glances add up. Aim for under one second per glance.');
    }
    const drowsy = (byType.EYES_CLOSED || 0) + (byType.MICROSLEEP || 0) + (byType.PERCLOS || 0) + (byType.YAWNING || 0) + (byType.HEAD_NOD || 0);
    if (drowsy > 0) {
      push(90 + drowsy * 5, 'bed-outline', 'Signs of drowsiness',
        'Yawns, nods or slow blinks were detected. Rest before driving again.');
    }
  }

  const stops = Number(metrics.suddenStops) || 0;
  if (stops / (durationMin / 10) >= 1) {
    push(60 + stops * 4, 'speedometer-outline', `${stops} hard brake${stops === 1 ? '' : 's'}`,
      'Leave more following distance so you can slow down gradually.');
  }
  const accels = Number(metrics.suddenAccelerations) || 0;
  if (accels / (durationMin / 10) >= 1) {
    push(50 + accels * 3, 'trending-up-outline', `${accels} hard acceleration${accels === 1 ? '' : 's'}`,
      'Ease onto the throttle; smooth starts save fuel and points.');
  }
  const speeding = Number(metrics.speedingEvents) || 0;
  const margin = Number(metrics.avgSpeedingMargin) || 0;
  if (speeding > 0) {
    push(70 + speeding * 5 + margin * 2, 'warning-outline', `${speeding} speeding event${speeding === 1 ? '' : 's'}`,
      margin > 0
        ? `You averaged ${margin.toFixed(0)} over the limit when speeding. Points stop above 125 % of the limit.`
        : 'Keep within the posted limit to earn at the full rate.');
  }

  if (tips.length === 0) {
    push(1, 'shield-checkmark-outline', 'Clean drive', 'No pickups, no hard stops, no speeding. Keep the streak going.');
  }
  return tips.sort((a, b) => b.weight - a.weight).slice(0, max).map(({ weight, ...rest }) => rest);
}

// Aggregate helper for "this week" style summaries.
export function summarizeDrives(drives = []) {
  let focused = 0;
  let duration = 0;
  let distance = 0;
  let eyesOff = 0;
  let points = 0;
  let scoreSum = 0;
  let scoreCount = 0;
  for (const d of drives) {
    const distracted = d.wasDistracted ?? (Number(d.distracted) || 0) > 0;
    if (!distracted) focused += 1;
    duration += Number(d.duration) || 0;
    distance += Number(d.totalDistance) || 0;
    eyesOff += Number(d.eyesOffRoadSeconds ?? d.monitoring?.eyesOffRoadSeconds) || 0;
    points += Number(d.points) || 0;
    const s = typeof d.score === 'number' ? d.score : scoreDrive(d).score;
    scoreSum += s;
    scoreCount += 1;
  }
  const count = drives.length;
  return {
    count,
    focused,
    focusedPct: count ? Math.round((focused / count) * 100) : null,
    duration,
    distance,
    eyesOffRoadSeconds: eyesOff,
    points,
    avgScore: scoreCount ? Math.round(scoreSum / scoreCount) : null,
  };
}
