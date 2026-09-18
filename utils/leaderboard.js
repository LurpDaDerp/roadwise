// Leaderboard reads shared by the Rewards tab preview and the Leaderboard screen.
// Queries are the ones the pre-rework LeaderboardScreen used: `users` ordered by
// `points` descending with a limit, plus a server-side count when the signed-in
// user sits outside that window.
import {
  collection,
  doc,
  getDoc,
  getDocs,
  getCountFromServer,
  query,
  orderBy,
  limit,
  where,
} from 'firebase/firestore';
import { auth, db } from './firebase';

export const LEADERBOARD_SIZE = 50;

// The board is read on EVERY Leaderboard focus (50 user documents + a count) and on every
// Rewards focus (3 more). Nobody's rank moves in the seconds it takes to flip between tabs, so
// a short TTL keyed on (uid, count) removes the repeat reads and the radio wake-ups with them.
const TTL_MS = 5 * 60 * 1000;
const cache = new Map();   // `${uid}:${count}` -> { at, value }

export function invalidateLeaderboard() {
  cache.clear();
}

function rowFromDoc(snap) {
  const data = snap.data() || {};
  return {
    id: snap.id,
    name: data.username || 'Driver',
    points: Number(data.points) || 0,
    photoURL: data.photoURL || null,
  };
}

// fetchLeaderboard(uid, count) -> { rows, me }
// rows: [{ id, name, points, photoURL }] ordered by points desc (highest first).
// me:   { id, name, points, rank } for the signed-in user, or null when signed
//       out / no profile document. `rank` is the index in `rows` + 1 when the
//       user is inside the window, otherwise "users with more points" + 1.
// Throws on failure so callers can show a retry affordance.
export async function fetchLeaderboard(uid, count = LEADERBOARD_SIZE, { force = false } = {}) {
  // Every query below needs an authenticated caller (the rules allow `list` on users only to
  // signed-in accounts); without this the first read after a sign-out throws permission-denied
  // and the screen shows a retry for something that can never succeed.
  if (!auth.currentUser) return { rows: [], me: null };

  const key = `${uid || 'anon'}:${count}`;
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const usersRef = collection(db, 'users');
  const snapshot = await getDocs(query(usersRef, orderBy('points', 'desc'), limit(count)));
  const rows = snapshot.docs.map(rowFromDoc);

  if (!uid) return remember(key, { rows, me: null });

  const index = rows.findIndex((r) => r.id === uid);
  if (index >= 0) {
    return remember(key, { rows, me: { ...rows[index], rank: index + 1 } });
  }

  const userSnap = await getDoc(doc(db, 'users', uid));
  if (!userSnap.exists()) return remember(key, { rows, me: null });

  const mine = rowFromDoc(userSnap);
  const higher = await getCountFromServer(query(usersRef, where('points', '>', mine.points)));
  return remember(key, {
    rows,
    me: { ...mine, rank: (higher.data().count || 0) + 1 },
  });
}

function remember(key, value) {
  cache.set(key, { at: Date.now(), value });
  return value;
}
