// useEmergency — the in-drive SOS actions (moved out of DriveScreen).
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Linking } from 'react-native';
import * as Location from 'expo-location';
import { auth } from '../utils/firebase';
import { getTrustedContacts } from '../utils/firestore';
import { getCachedGroupId } from '../utils/groupCache';
import { getGroup, setEmergency } from '../utils/groups';

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
        const groupId = await getCachedGroupId(uid);
        if (!groupId) return;                    // null = no group, undefined = read failed
        const group = await getGroup(groupId);
        const flag = !!group?.memberLocations?.[uid]?.emergency;
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
      // getCachedGroupId is three-valued: a group id, null (definitely no group) or undefined
      // (the read failed). Telling someone in an emergency that they are "not in a group" because
      // Firestore was unreachable is the worst possible failure mode.
      const groupId = await getCachedGroupId(uid);
      if (groupId === undefined) throw new Error('group lookup failed');
      if (!groupId) {
        Alert.alert('Not in a group', 'Join a family group from the Family tab to send emergency alerts.');
        return false;
      }
      // Pins the position when a fix is available; the write only ever touches this
      // member's own memberLocations entry (utils/groups.js#setEmergency).
      const fix = await getFixWithTimeout(6000);
      const ok = await setEmergency(uid, groupId, true, fix?.coords || null);
      if (!ok) throw new Error('emergency write failed');
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
      // A failed group lookup must NOT report a cleared alert: the drive screen's "Couldn't
      // clear your SOS" retry exists precisely for this case.
      const groupId = await getCachedGroupId(uid);
      if (groupId === undefined) throw new Error('group lookup failed');
      if (groupId) {
        const ok = await setEmergency(uid, groupId, false);
        if (!ok) throw new Error('emergency write failed');
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

  // Memoised: DriveScreen builds `clearSosBounded` -> `endDrive` -> the hold-to-end button's
  // prop out of this object, so a fresh identity on every render re-created that whole chain on
  // every GPS fix and defeated any memoisation below it.
  return useMemo(
    () => ({ trustedContacts, isEmergencyActive, busy, notifyGroup, cancelGroupEmergency, callNumber }),
    [trustedContacts, isEmergencyActive, busy, notifyGroup, cancelGroupEmergency]
  );
}

export default useEmergency;
