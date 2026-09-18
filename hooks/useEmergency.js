// useEmergency — the in-drive SOS actions (moved out of DriveScreen).
import { useCallback, useEffect, useState } from 'react';
import { Alert, Linking } from 'react-native';
import * as Location from 'expo-location';
import { doc, getDoc, updateDoc } from 'firebase/firestore';
import { auth, db } from '../utils/firebase';
import { getTrustedContacts } from '../utils/firestore';

export function callNumber(phone) {
  if (!phone) {
    Alert.alert('No number', 'No phone number provided.');
    return;
  }
  const url = `tel:${String(phone).replace(/[^\d+]/g, '')}`;
  Linking.canOpenURL(url)
    .then((supported) => {
      if (!supported) Alert.alert('Not supported', 'Phone calls are not supported on this device.');
      else return Linking.openURL(url);
    })
    .catch((err) => console.error('Failed to call number:', err));
}

// uid: the signed-in user (from AuthContext) so the contacts and the current
// emergency flag load as soon as auth is restored.
// A quick fix: a ≤ 10 s old cached position is fine; give up after `ms` and
// fall back to the last known position so the alert never hangs on GPS.
async function getFixWithTimeout(ms) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), ms));
  try {
    const fresh = await Promise.race([
      Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced, maximumAge: 10000 }),
      timeout,
    ]);
    if (fresh) return fresh;
  } catch {}
  try {
    return await Location.getLastKnownPositionAsync({ maxAge: 10 * 60 * 1000 });
  } catch {
    return null;
  }
}

export function useEmergency(uidParam) {
  const [trustedContacts, setTrustedContacts] = useState([]);
  const [isEmergencyActive, setIsEmergencyActive] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const uid = uidParam || auth.currentUser?.uid;
    if (!uid) return undefined;
    let cancelled = false;
    getTrustedContacts(uid).then((c) => {
      if (!cancelled) setTrustedContacts(Array.isArray(c) ? c : []);
    });
    // Hydrate the emergency flag so the sheet offers "I'm safe" when it is already set.
    (async () => {
      try {
        const userSnap = await getDoc(doc(db, 'users', uid));
        const groupId = userSnap.exists() ? userSnap.data().groupId : null;
        if (!groupId) return;
        const groupSnap = await getDoc(doc(db, 'groups', groupId));
        const flag = groupSnap.exists() ? !!groupSnap.data()?.memberLocations?.[uid]?.emergency : false;
        if (!cancelled) setIsEmergencyActive(flag);
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [uidParam]);

  const notifyGroup = useCallback(async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return false;
    setBusy(true);
    try {
      const userSnap = await getDoc(doc(db, 'users', uid));
      const groupId = userSnap.exists() ? userSnap.data().groupId : null;
      if (!groupId) {
        Alert.alert('Not in a group', 'Join a family group from the Family tab to send emergency alerts.');
        return false;
      }
      const groupRef = doc(db, 'groups', groupId);
      const fix = await getFixWithTimeout(6000);
      const { latitude, longitude, speed } = fix?.coords || {};
      await updateDoc(groupRef, {
        [`memberLocations.${uid}.latitude`]: latitude ?? null,
        [`memberLocations.${uid}.longitude`]: longitude ?? null,
        [`memberLocations.${uid}.speed`]: speed ?? 0,
        [`memberLocations.${uid}.updatedAt`]: new Date(),
        [`memberLocations.${uid}.emergency`]: true,
      });
      setIsEmergencyActive(true);
      return true;
    } catch (err) {
      console.error('Error notifying group:', err);
      Alert.alert('Could not notify', 'Failed to notify your group. Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const cancelGroupEmergency = useCallback(async () => {
    const uid = auth.currentUser?.uid;
    if (!uid) return false;
    setBusy(true);
    try {
      const userSnap = await getDoc(doc(db, 'users', uid));
      const groupId = userSnap.exists() ? userSnap.data().groupId : null;
      if (groupId) {
        await updateDoc(doc(db, 'groups', groupId), { [`memberLocations.${uid}.emergency`]: false });
      }
      setIsEmergencyActive(false);
      return true;
    } catch (err) {
      console.error('Error cancelling emergency:', err);
      Alert.alert('Could not cancel', 'Failed to cancel the emergency. Please try again.');
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { trustedContacts, isEmergencyActive, busy, notifyGroup, cancelGroupEmergency, callNumber };
}

export default useEmergency;
