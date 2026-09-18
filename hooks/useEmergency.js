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

export function useEmergency() {
  const [trustedContacts, setTrustedContacts] = useState([]);
  const [isEmergencyActive, setIsEmergencyActive] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const uid = auth.currentUser?.uid;
    if (!uid) return;
    getTrustedContacts(uid).then((c) => setTrustedContacts(Array.isArray(c) ? c : []));
  }, []);

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
      const loc = await Location.getCurrentPositionAsync({});
      const { latitude, longitude, speed } = loc.coords;
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
