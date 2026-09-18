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
import { db } from './firebase';

export const LEADERBOARD_SIZE = 50;

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
export async function fetchLeaderboard(uid, count = LEADERBOARD_SIZE) {
  const usersRef = collection(db, 'users');
  const snapshot = await getDocs(query(usersRef, orderBy('points', 'desc'), limit(count)));
  const rows = snapshot.docs.map(rowFromDoc);

  if (!uid) return { rows, me: null };

  const index = rows.findIndex((r) => r.id === uid);
  if (index >= 0) {
    return { rows, me: { ...rows[index], rank: index + 1 } };
  }

  const userSnap = await getDoc(doc(db, 'users', uid));
  if (!userSnap.exists()) return { rows, me: null };

  const mine = rowFromDoc(userSnap);
  const higher = await getCountFromServer(query(usersRef, where('points', '>', mine.points)));
  return {
    rows,
    me: { ...mine, rank: (higher.data().count || 0) + 1 },
  };
}
