import { getFirestore, doc, getDoc, setDoc, updateDoc, collection, addDoc, getDocs, orderBy, where, query, deleteDoc, serverTimestamp } from "firebase/firestore";
import { db } from './firebase';

export async function getUserPoints(uid) {
  const docRef = doc(db, "users", uid);
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
    return docSnap.data().points || 0;
  } else {
    await setDoc(docRef, { points: 0 });
    return 0;
  }
}

export async function saveUserPoints(uid, points) {
  const docRef = doc(db, "users", uid);
  await setDoc(docRef, { points }, { merge: true });
}

export async function getUsername(uid) {
  const docRef = doc(db, "users", uid);
  const docSnap = await getDoc(docRef);
  if (docSnap.exists()) {
    return docSnap.data().username || "guest";
  } else {
    await setDoc(docRef, { username: uid });
    return "guest";
  }
}


export async function getTotalDrivesNumber(uid) {
  if (!uid) return 0;

  try {
    const metricsRef = collection(db, "users", uid, "drivemetrics");
    const snapshot = await getDocs(metricsRef);
    return snapshot.size;
  } catch (error) {
    return 0;
  }
}

export async function saveUserStreak(uid, streak) {
  if (!uid) return;
  const userRef = doc(db, 'users', uid);
  try {
    await updateDoc(userRef, { drivingStreak: streak });
  } catch (error) {
    console.error('Failed to save user streak:', error);
  }
}

export async function saveTrustedContacts(uid, contacts) {
  if (!uid) return;
  const userRef = doc(db, "users", uid);
  try {
    await setDoc(userRef, { trustedContacts: contacts }, { merge: true });
  } catch (error) {
    console.error("Error saving trusted contacts:", error);
  }
}

export async function getTrustedContacts(uid) {
  if (!uid) return [];
  const userRef = doc(db, "users", uid);
  try {
    const docSnap = await getDoc(userRef);
    if (docSnap.exists()) {
      return docSnap.data().trustedContacts || [];
    } else {
      return [];
    }
  } catch (error) {
    console.error("Error loading trusted contacts:", error);
    return [];
  }
}

export async function getUserDrives(uid) {
  if (!uid) return [];
  try {
    const drivesRef = collection(db, "users", uid, "drivemetrics");
    const q = query(drivesRef, orderBy("timestamp", "desc"));
    const snapshot = await getDocs(q);
    const drives =  snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      timestamp: doc.data().timestamp?.toDate?.() || new Date()
    }));
    return drives;
  } catch (error) {
    return [];
  }
}

export async function saveDriveMetrics(uid, metrics) {
  if (!uid) return;

  const writeOnce = async () => {
    const metricsRef = collection(db, "users", uid, "drivemetrics");
    await addDoc(metricsRef, {
      ...metrics,
      timestamp: serverTimestamp(),
    });
  };

  try {
    await writeOnce();
  } catch (err) {
    try {
      const userDocRef = doc(db, "users", uid);
      const userSnap = await getDoc(userDocRef);
      if (!userSnap.exists()) {
        await setDoc(userDocRef, { createdAt: serverTimestamp() }, { merge: true });
      }

      await writeOnce();
    } catch (retryErr) {
      console.error("Failed to save drive metrics (after init):", retryErr);
    }
  }
}

export async function getDriveMetrics(uid, daysBack = 30) {
  try {
    const metricsRef = collection(db, "users", uid, "drivemetrics");
    const snapshot = await getDocs(metricsRef);

    const allMetrics = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

    const now = new Date();
    const cutoff = new Date();
    cutoff.setDate(now.getDate() - daysBack);

    const filtered = allMetrics.filter(drive => {
      const date = drive.timestamp?.toDate ? drive.timestamp.toDate() : new Date(drive.timestamp);
      return date >= cutoff && date <= now;
    });

    filtered.sort((a, b) => {
      const dateA = a.timestamp?.toDate ? a.timestamp.toDate() : new Date(a.timestamp);
      const dateB = b.timestamp?.toDate ? b.timestamp.toDate() : new Date(b.timestamp);
      return dateA - dateB;
    });

    return filtered;
  } catch (err) {
    console.error("Failed to fetch drive metrics:", err);
    return [];
  }
}


export async function getAllDriveMetrics(uid) {
  try {
    const metricsRef = collection(db, "users", uid, "drivemetrics");
    const snapshot = await getDocs(metricsRef);
    const metrics = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return metrics;
  } catch (err) {
    return [];
  }
}

export async function clearUserDrives(uid) {
  if (!uid) return;
  try {
    const drivesRef = collection(db, "users", uid, "drivemetrics");
    const snapshot = await getDocs(drivesRef);
    for (const docSnap of snapshot.docs) {
      await deleteDoc(doc(db, "users", uid, "drivemetrics", docSnap.id));
    }
  } catch (error) {
    console.error("Error clearing user drives:", error);
  }
}

export const startDriving = async (userId) => {
  try {
    const userRef = doc(db, "users", userId);

    await setDoc(
      userRef,
      { isDriving: true },
      { merge: true } 
    );

  } catch (error) {
    console.error("Error setting isDriving to true:", error);
  }
};

export const stopDriving = async (userId) => {
  try {
    const userRef = doc(db, "users", userId);

    await setDoc(
      userRef,
      { isDriving: false },
      { merge: true }
    );

  } catch (error) {
    console.error("Error setting isDriving to false:", error);
  }
};

// ---------------------------------------------------------------------------
// Added by the UX rework (docs/UX_REWORK.md §8). Existing functions above are
// untouched; these are the only additions.
// ---------------------------------------------------------------------------

import { increment, limit as fsLimit } from "firebase/firestore";

// Atomically add `delta` points to users/{uid}.points (replaces the
// read-modify-write hand-off through AsyncStorage at the end of a drive).
export async function addUserPoints(uid, delta) {
  if (!uid) return;
  const n = Number(delta) || 0;
  if (n === 0) return;
  const userRef = doc(db, "users", uid);
  try {
    await setDoc(userRef, { points: increment(n) }, { merge: true });
  } catch (error) {
    console.error("Failed to add user points:", error);
  }
}

// The user's profile document (username, points, drivingStreak, photoURL, groupId, ...).
export async function getUserProfile(uid) {
  if (!uid) return null;
  try {
    const snap = await getDoc(doc(db, "users", uid));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  } catch (error) {
    console.error("Failed to load user profile:", error);
    return null;
  }
}

// Newest `count` drives, timestamps converted to Date (for the Home screen).
export async function getRecentDrives(uid, count = 5) {
  if (!uid) return [];
  try {
    const drivesRef = collection(db, "users", uid, "drivemetrics");
    const q = query(drivesRef, orderBy("timestamp", "desc"), fsLimit(count));
    const snapshot = await getDocs(q);
    return snapshot.docs.map((d) => ({
      id: d.id,
      ...d.data(),
      timestamp: d.data().timestamp?.toDate?.() || new Date(),
    }));
  } catch (error) {
    return [];
  }
}
