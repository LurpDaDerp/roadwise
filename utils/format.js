// Small display formatters shared by the drive, history and summary screens.

export const MPS_TO_MPH = 2.23694;
export const MPS_TO_KPH = 3.6;
export const METERS_PER_MILE = 1609.34;

export function speedFromMps(mps, unit) {
  const v = Number(mps) || 0;
  return unit === 'kph' ? v * MPS_TO_KPH : v * MPS_TO_MPH;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.round(s / 60);
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const min = minutes - hours * 60;
    return min > 0 ? `${hours} hr ${min} min` : `${hours} hr`;
  }
  if (minutes === 0) return `${s} sec`;
  return `${minutes} min`;
}

export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatDistance(meters, unit = 'mph') {
  const m = Number(meters) || 0;
  if (unit === 'kph') {
    const km = m / 1000;
    if (km < 0.1) return `${Math.round(m)} m`;
    return `${km.toFixed(1)} km`;
  }
  const miles = m / METERS_PER_MILE;
  if (miles < 0.1) return `${Math.round(m * 3.28084)} ft`;
  return `${miles.toFixed(1)} mi`;
}

export function distanceValue(meters, unit = 'mph') {
  const m = Number(meters) || 0;
  return unit === 'kph' ? m / 1000 : m / METERS_PER_MILE;
}

export function distanceUnitLabel(unit = 'mph') {
  return unit === 'kph' ? 'km' : 'mi';
}

export function formatSpeed(value, unit = 'mph') {
  const v = Math.round(Number(value) || 0);
  return `${v} ${unit === 'kph' ? 'km/h' : 'mph'}`;
}

export function toDate(ts) {
  if (!ts) return new Date(NaN);
  if (ts instanceof Date) return ts;
  if (typeof ts?.toDate === 'function') return ts.toDate();
  if (typeof ts === 'object' && typeof ts.seconds === 'number') return new Date(ts.seconds * 1000);
  return new Date(ts);
}

export function formatDateTime(ts) {
  const d = toDate(ts);
  if (isNaN(d)) return '';
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} · ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export function formatDayHeading(ts) {
  const d = toDate(ts);
  if (isNaN(d)) return '';
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const same = (a, b) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, today)) return 'Today';
  if (same(d, yesterday)) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function relativeTime(ts) {
  const d = toDate(ts);
  if (isNaN(d)) return '';
  const diff = Math.max(0, Date.now() - d.getTime());
  const s = Math.floor(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const days = Math.floor(h / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function pluralize(n, singular, plural = `${singular}s`) {
  return `${n} ${n === 1 ? singular : plural}`;
}

// Navigation params must be serializable: convert a drive record's Date /
// Firestore Timestamp fields to ISO strings before passing it as a param.
export function serializeDrive(drive) {
  if (!drive) return drive;
  const out = { ...drive };
  if (out.timestamp) {
    const d = toDate(out.timestamp);
    out.timestamp = isNaN(d) ? String(out.timestamp) : d.toISOString();
  }
  return out;
}
