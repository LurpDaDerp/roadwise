// useFamilyGroup — the Family tab's data layer: the live group document, the
// member list with resolved addresses, and every write the screen performs
// (create, join, leave, saved places, clearing an emergency).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  onSnapshot,
  collection,
  query,
  where,
  arrayUnion,
  arrayRemove,
  writeBatch,
  deleteField,
  serverTimestamp,
} from 'firebase/firestore';
import { db } from '../../utils/firebase';
import { ensureLocationSharing, stopLocationUpdates, updateCachedGroupId } from '../../utils/LocationService';
import { getDistance, reverseGeocode, makeGroupCode } from '../../utils/geo';

const ADDRESS_MIN_METERS = 10;
const MY_ADDRESS_MIN_MS = 10000;

function tsValue(ts) {
  if (!ts) return 0;
  if (typeof ts.seconds === 'number') return ts.seconds;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  return Number(ts) || 0;
}

function sameMember(a, b) {
  return (
    !!a &&
    !!b &&
    a.name === b.name &&
    a.photoURL === b.photoURL &&
    a.phone === b.phone &&
    a.emergency === b.emergency &&
    a.speed === b.speed &&
    a.displayName === b.displayName &&
    a.address === b.address &&
    (a.coords?.latitude ?? null) === (b.coords?.latitude ?? null) &&
    (a.coords?.longitude ?? null) === (b.coords?.longitude ?? null) &&
    tsValue(a.updatedAt) === tsValue(b.updatedAt)
  );
}

// Rebuilds the member list from a group snapshot, reusing the previous objects
// wherever nothing changed so the map markers are not re-rendered.
function buildMembers(prev, memberLocations, profiles) {
  const prevMap = new Map(prev.map((m) => [m.uid, m]));
  let changed = prev.length !== Object.keys(memberLocations).length;

  const next = Object.keys(memberLocations).map((uid) => {
    const raw = memberLocations[uid] || {};
    const before = prevMap.get(uid);
    const profile = profiles[uid] || {};
    const latitude = raw.latitude ?? null;
    const longitude = raw.longitude ?? null;
    const member = {
      uid,
      name: profile.name || before?.name || 'Member',
      photoURL: profile.photoURL ?? before?.photoURL ?? null,
      phone: profile.phone ?? before?.phone ?? null,
      speed: Number(raw.speed) || 0,
      updatedAt: raw.updatedAt ?? null,
      emergency: raw.emergency === true,
      coords: latitude == null || longitude == null ? null : { latitude, longitude },
      displayName: before?.displayName ?? null,
      address: before?.address ?? null,
    };
    if (before && sameMember(before, member)) return before;
    changed = true;
    return member;
  });

  return changed ? next : prev;
}

export function useFamilyGroup({ uid, profileGroupId, location, onBeforeStart }) {
  // Derived: the live profile document is the source of truth; create / join /
  // leave set an optimistic value only until the snapshot catches up.
  const [optimisticGroupId, setOptimisticGroupId] = useState(undefined);
  const groupId = optimisticGroupId !== undefined ? optimisticGroupId : profileGroupId;
  const setGroupId = setOptimisticGroupId;
  const [groupName, setGroupName] = useState('');
  const [members, setMembers] = useState([]);
  const [places, setPlaces] = useState([]);
  const [loaded, setLoaded] = useState(false);

  const profilesRef = useRef({});
  const lastMemberCoordsRef = useRef({});
  const myGeocodeRef = useRef({ t: 0, lat: null, lon: null });

  // The profile document is live, so the group id follows it; create, join and
  // leave move it optimistically until the snapshot catches up.
  useEffect(() => setOptimisticGroupId(undefined), [profileGroupId]);

  const fetchProfiles = useCallback(async (uids) => {
    for (let i = 0; i < uids.length; i += 10) {
      const ids = uids.slice(i, i + 10);
      try {
        const snap = await getDocs(query(collection(db, 'users'), where('__name__', 'in', ids)));
        snap.forEach((d) => {
          const u = d.data() || {};
          profilesRef.current[d.id] = {
            name: u.username || 'Member',
            photoURL: u.photoURL || null,
            phone: u.phone || null,
          };
        });
      } catch (e) {
        console.warn('Member profile lookup failed:', e);
      }
      ids.forEach((id) => {
        if (!profilesRef.current[id]) profilesRef.current[id] = { name: 'Member', photoURL: null, phone: null };
      });
    }
  }, []);

  const setMemberAddress = useCallback((memberUid, result) => {
    setMembers((prev) =>
      prev.map((m) =>
        m.uid === memberUid ? { ...m, displayName: result.displayName, address: result.address } : m
      )
    );
  }, []);

  useEffect(() => {
    if (!groupId) {
      setMembers([]);
      setPlaces([]);
      setGroupName('');
      setLoaded(false);
      return undefined;
    }
    setLoaded(false);
    let cancelled = false;
    const pending = new Set();

    const unsub = onSnapshot(
      doc(db, 'groups', groupId),
      (snap) => {
        if (cancelled) return;
        setLoaded(true);
        if (!snap.exists()) return;
        const data = snap.data() || {};
        const memberLocations = data.memberLocations || {};
        const saved = Array.isArray(data.savedLocations) ? data.savedLocations : [];
        setGroupName(data.groupName || '');
        setPlaces(saved);

        const commit = () => setMembers((prev) => buildMembers(prev, memberLocations, profilesRef.current));
        commit();

        const missing = Object.keys(memberLocations).filter((id) => !profilesRef.current[id]);
        if (missing.length) {
          fetchProfiles(missing).then(() => {
            if (!cancelled) commit();
          });
        }

        // One reverse geocode per member per 10 m moved, one request in flight
        // per coordinate. The signed-in user is resolved from the live fix.
        Object.keys(memberLocations).forEach((memberUid) => {
          if (memberUid === uid) return;
          const c = memberLocations[memberUid];
          if (c?.latitude == null || c?.longitude == null) return;
          const last = lastMemberCoordsRef.current[memberUid];
          if (last && getDistance(last.latitude, last.longitude, c.latitude, c.longitude) < ADDRESS_MIN_METERS) {
            return;
          }
          const key = `${memberUid}:${c.latitude.toFixed(5)}:${c.longitude.toFixed(5)}`;
          if (pending.has(key)) return;
          pending.add(key);
          lastMemberCoordsRef.current[memberUid] = { latitude: c.latitude, longitude: c.longitude };
          reverseGeocode(c.latitude, c.longitude, saved)
            .then((r) => {
              if (!cancelled) setMemberAddress(memberUid, r);
            })
            .catch(() => {
              // Let the next snapshot retry instead of leaving the member on "Locating".
              delete lastMemberCoordsRef.current[memberUid];
            })
            .finally(() => pending.delete(key));
        });
      },
      (e) => {
        console.warn('Group subscription failed:', e);
        if (!cancelled) setLoaded(true);
      }
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, [groupId, uid, fetchProfiles, setMemberAddress]);

  // My own address, from the live fix, at most every 10 s / 10 m.
  useEffect(() => {
    if (!location || !uid || !groupId) return undefined;
    const now = Date.now();
    const last = myGeocodeRef.current;
    const moved =
      last.lat == null ? Infinity : getDistance(last.lat, last.lon, location.latitude, location.longitude);
    if (last.t && (now - last.t < MY_ADDRESS_MIN_MS || moved < ADDRESS_MIN_METERS)) return undefined;
    myGeocodeRef.current = { t: now, lat: location.latitude, lon: location.longitude };
    let cancelled = false;
    reverseGeocode(location.latitude, location.longitude, places)
      .then((r) => {
        if (!cancelled) setMemberAddress(uid, r);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [location, places, uid, groupId, setMemberAddress]);

  const startSharing = useCallback(async () => {
    try {
      if (onBeforeStart) await onBeforeStart();
    } catch (e) {
      console.warn('Permission request failed:', e);
    }
    await ensureLocationSharing();
  }, [onBeforeStart]);

  const createGroup = useCallback(
    async (name) => {
      if (!uid) return { ok: false, error: 'You need to be signed in.' };
      const newId = makeGroupCode();
      try {
        // The group document is written first so the name, the owner and the
        // created date survive; only then does the user point at it.
        await setDoc(
          doc(db, 'groups', newId),
          {
            groupName: name,
            createdBy: uid,
            createdAt: serverTimestamp(),
            savedLocations: [],
            memberLocations: {},
          },
          { merge: true }
        );
        await setDoc(doc(db, 'users', uid), { groupId: newId }, { merge: true });
        await updateCachedGroupId(uid, newId);
        setGroupId(newId);
        // Fire-and-forget: the panel unmounts as soon as groupId is set, and
        // startSharing blocks on OS permission dialogs and a GPS fix.
        startSharing().catch((e) => console.warn('Location sharing start failed:', e));
        return { ok: true };
      } catch (e) {
        console.warn('Create group failed:', e);
        return { ok: false, error: 'Could not create the group. Check your connection and try again.' };
      }
    },
    [uid, startSharing]
  );

  const joinGroup = useCallback(
    async (code) => {
      if (!uid) return { ok: false, error: 'You need to be signed in.' };
      try {
        const snap = await getDoc(doc(db, 'groups', code));
        if (!snap.exists()) return { ok: false, error: 'No group has that code. Check it and try again.' };
        await setDoc(doc(db, 'users', uid), { groupId: code }, { merge: true });
        await updateCachedGroupId(uid, code);
        setGroupId(code);
        // Fire-and-forget: the panel unmounts as soon as groupId is set, and
        // startSharing blocks on OS permission dialogs and a GPS fix.
        startSharing().catch((e) => console.warn('Location sharing start failed:', e));
        return { ok: true };
      } catch (e) {
        console.warn('Join group failed:', e);
        return { ok: false, error: 'Could not join that group. Check your connection and try again.' };
      }
    },
    [uid, startSharing]
  );

  const leaveGroup = useCallback(async () => {
    if (!groupId || !uid) return;
    const leaving = groupId;
    try {
      await setDoc(doc(db, 'users', uid), { groupId: null }, { merge: true });
      await updateCachedGroupId(uid, null);
      await updateDoc(doc(db, 'groups', leaving), { [`memberLocations.${uid}`]: deleteField() });
    } catch (e) {
      console.warn('Leave group failed:', e);
    }
    setGroupId(null);
    stopLocationUpdates();
  }, [groupId, uid]);

  const clearEmergency = useCallback(async () => {
    if (!groupId || !uid) return;
    try {
      await updateDoc(doc(db, 'groups', groupId), { [`memberLocations.${uid}.emergency`]: false });
    } catch (e) {
      console.warn('Could not clear the emergency:', e);
    }
  }, [groupId, uid]);

  const savePlace = useCallback(
    async (place, editing) => {
      if (!groupId) return { ok: false, error: 'You are not in a group.' };
      const ref = doc(db, 'groups', groupId);
      try {
        // One atomic write: remove the old entry (when editing) and add the new one.
        const batch = writeBatch(db);
        if (editing) batch.update(ref, { savedLocations: arrayRemove(editing) });
        batch.update(ref, { savedLocations: arrayUnion({ ...place, createdBy: editing?.createdBy || uid }) });
        await batch.commit();
        return { ok: true };
      } catch (e) {
        console.warn('Save place failed:', e);
        return { ok: false, error: 'Could not save this place.' };
      }
    },
    [groupId, uid]
  );

  const deletePlace = useCallback(
    async (place) => {
      if (!groupId || !place) return { ok: false, error: 'You are not in a group.' };
      try {
        await updateDoc(doc(db, 'groups', groupId), { savedLocations: arrayRemove(place) });
        return { ok: true };
      } catch (e) {
        console.warn('Delete place failed:', e);
        return { ok: false, error: 'Could not delete this place.' };
      }
    },
    [groupId]
  );

  return useMemo(
    () => ({
      groupId,
      groupName,
      members,
      places,
      loaded,
      createGroup,
      joinGroup,
      leaveGroup,
      clearEmergency,
      savePlace,
      deletePlace,
    }),
    [groupId, groupName, members, places, loaded, createGroup, joinGroup, leaveGroup, clearEmergency, savePlace, deletePlace]
  );
}

export default useFamilyGroup;
