// Badges computed from the drive history and profile — no backend needed.
import { toDate } from './format';

const METERS_PER_MILE = 1609.34;

function isDistracted(d) {
  return d.wasDistracted ?? (Number(d.distracted) || 0) > 0;
}

function longestFocusedRun(drives) {
  // drives sorted newest first; count consecutive focused drives from the newest.
  let run = 0;
  let best = 0;
  for (const d of drives) {
    if (isDistracted(d)) {
      best = Math.max(best, run);
      run = 0;
    } else {
      run += 1;
    }
  }
  return Math.max(best, run);
}

export const BADGES = [
  { id: 'first_drive', title: 'First drive', body: 'Complete your first drive.', icon: 'car-sport-outline', target: 1,
    progress: ({ drives }) => drives.length },
  { id: 'focused_5', title: 'Focused ×5', body: 'Five focused drives in a row.', icon: 'eye-outline', target: 5,
    progress: ({ drives }) => longestFocusedRun(drives) },
  { id: 'focused_25', title: 'Focused ×25', body: 'Twenty-five focused drives in a row.', icon: 'ribbon-outline', target: 25,
    progress: ({ drives }) => longestFocusedRun(drives) },
  { id: 'miles_100', title: '100 miles', body: 'Drive 100 miles with RoadWise.', icon: 'map-outline', target: 100,
    progress: ({ drives }) => Math.floor(drives.reduce((s, d) => s + (Number(d.totalDistance) || 0), 0) / METERS_PER_MILE) },
  { id: 'miles_500', title: '500 miles', body: 'Drive 500 miles with RoadWise.', icon: 'compass-outline', target: 500,
    progress: ({ drives }) => Math.floor(drives.reduce((s, d) => s + (Number(d.totalDistance) || 0), 0) / METERS_PER_MILE) },
  { id: 'streak_7', title: 'Week streak', body: 'Reach a 7-drive focus streak.', icon: 'flame-outline', target: 7,
    progress: ({ streak }) => Number(streak) || 0 },
  { id: 'streak_30', title: 'Month streak', body: 'Reach a 30-drive focus streak.', icon: 'bonfire-outline', target: 30,
    progress: ({ streak }) => Number(streak) || 0 },
  { id: 'night_owl', title: 'Night owl', body: 'A focused drive that starts after 10 pm.', icon: 'moon-outline', target: 1,
    progress: ({ drives }) => drives.filter((d) => !isDistracted(d) && toDate(d.timestamp).getHours() >= 22).length },
  { id: 'early_bird', title: 'Early bird', body: 'A focused drive that starts before 7 am.', icon: 'sunny-outline', target: 1,
    progress: ({ drives }) => drives.filter((d) => !isDistracted(d) && toDate(d.timestamp).getHours() < 7).length },
  { id: 'eyes_on_road', title: 'Eyes on the road', body: 'A monitored drive with zero alerts.', icon: 'videocam-outline', target: 1,
    progress: ({ drives }) => drives.filter((d) => d.monitoring?.enabled && (Number(d.monitoring?.alertCounts?.warning) || 0) + (Number(d.monitoring?.alertCounts?.critical) || 0) === 0).length },
  { id: 'smooth_operator', title: 'Smooth operator', body: 'Ten drives without a hard brake.', icon: 'water-outline', target: 10,
    progress: ({ drives }) => drives.filter((d) => (Number(d.suddenStops) || 0) === 0 && (Number(d.duration) || 0) >= 300).length },
  { id: 'points_1000', title: '1,000 points', body: 'Earn a thousand points.', icon: 'diamond-outline', target: 1000,
    progress: ({ points }) => Number(points) || 0 },
];

export function computeBadges({ drives = [], streak = 0, points = 0 }) {
  const ctx = { drives, streak, points };
  return BADGES.map((b) => {
    let progress = 0;
    try {
      progress = b.progress(ctx);
    } catch (e) {
      progress = 0;
    }
    const clamped = Math.max(0, Math.min(b.target, progress));
    return {
      id: b.id,
      title: b.title,
      body: b.body,
      icon: b.icon,
      target: b.target,
      progress: clamped,
      unlocked: clamped >= b.target,
      fraction: b.target ? clamped / b.target : 0,
    };
  });
}
