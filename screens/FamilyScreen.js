// FamilyScreen — the Family tab. A live map of the group with a bottom sheet of
// members and saved places, or a create/join panel when the user has no group.
// Replaces LocationScreen; see docs/UX_REWORK.md, section "Family".
// The tab has no navigation header, so the screen is full-bleed and handles the
// safe area itself.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, Alert, StyleSheet } from 'react-native';
import MapView, { AnimatedRegion } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useRoute, useNavigation } from '@react-navigation/native';
import * as Location from 'expo-location';
import BottomSheet, { BottomSheetSectionList, BottomSheetView } from '@gorhom/bottom-sheet';

import { useAuthContext } from '../context/AuthContext';
import { useSettings } from '../context/SettingsContext';
import { usePermissions } from '../hooks/usePermissions';
import { purgeOldGeocodeCache, DARK_MAP_STYLE } from '../utils/geo';
import { useTheme, Button, IconButton, EmptyState, Skeleton, Eyebrow } from '../theme';
import {
  JoinCreatePanel,
  GroupHeader,
  EmergencyBanner,
  MemberRow,
  SavedPlaceRow,
  MemberSheet,
  AddPlaceSheet,
  MemberMarker,
  PermissionBanners,
  useFamilyGroup,
} from '../components/family';

const DELTA = { latitudeDelta: 0.01, longitudeDelta: 0.01 };
const SNAP_POINTS = ['18%', '45%', '88%'];

export default function FamilyScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const route = useRoute();
  const navigation = useNavigation();
  const perms = usePermissions();
  const { settings } = useSettings();
  const { uid, username, photoURL, groupId: profileGroupId, profileLoaded } = useAuthContext();

  const [location, setLocation] = useState(null);
  const [selectedUid, setSelectedUid] = useState(null);
  const [placeSheetOpen, setPlaceSheetOpen] = useState(false);
  const [editingPlace, setEditingPlace] = useState(null);
  const [containerHeight, setContainerHeight] = useState(0);

  const mapRef = useRef(null);
  const sheetRef = useRef(null);
  const hasFixRef = useRef(false);
  const myCoord = useRef(new AnimatedRegion({ latitude: 0, longitude: 0, ...DELTA })).current;

  // Background location and notifications are asked for here, when the user
  // commits to a group — never on mount.
  const requestSharingPermissions = useCallback(async () => {
    await perms.requestBackground();
    await perms.requestNotifications();
  }, [perms]);

  const family = useFamilyGroup({
    uid,
    profileGroupId,
    location,
    onBeforeStart: requestSharingPermissions,
  });
  const { groupId, groupName, members, places, loaded } = family;

  const unit = settings?.speedUnit || 'mph';
  const selectedMember = useMemo(
    () => members.find((m) => m.uid === selectedUid) || null,
    [members, selectedUid]
  );

  useFocusEffect(useCallback(() => { purgeOldGeocodeCache(); }, []));

  // ---- my position -------------------------------------------------------
  useEffect(() => {
    if (perms.location !== 'granted') return undefined;
    let sub = null;
    let anim = null;
    let cancelled = false;
    (async () => {
      try {
        const created = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.Balanced, distanceInterval: 5, timeInterval: 2000 },
          (loc) => {
            if (cancelled) return;
            const { latitude, longitude } = loc.coords;
            setLocation({ latitude, longitude });
            if (!hasFixRef.current) {
              // Place the marker on the first fix; animating from (0, 0) would
              // fly the pin in from the Atlantic.
              hasFixRef.current = true;
              myCoord.setValue({ latitude, longitude, ...DELTA });
              return;
            }
            anim = myCoord.timing({ latitude, longitude, duration: 1000, useNativeDriver: false });
            anim.start();
          }
        );
        if (cancelled) created?.remove?.();
        else sub = created;
      } catch (e) {
        console.warn('watchPositionAsync failed:', e);
      }
    })();
    return () => {
      cancelled = true;
      anim?.stop?.();
      sub?.remove?.();
    };
  }, [perms.location, myCoord]);

  // ---- map actions -------------------------------------------------------
  const focusOn = useCallback((coords, duration = 500) => {
    if (!coords) return;
    sheetRef.current?.snapToIndex(0);
    mapRef.current?.animateToRegion({ ...coords, ...DELTA }, duration);
  }, []);

  const locateMember = useCallback((member) => focusOn(member?.coords, 600), [focusOn]);
  const recenter = useCallback(() => focusOn(location, 500), [focusOn, location]);

  // An emergency push notification lands here with the member's uid: centre the
  // map on them and open their sheet.
  useEffect(() => {
    const target = route.params?.emergencyUid;
    if (!target) return;
    const member = members.find((m) => m.uid === target);
    if (!member?.coords) return; // wait for the member's location to arrive
    setSelectedUid(target);
    focusOn(member.coords, 1000);
    navigation.setParams({ emergencyUid: null }); // consume it so the next push works again
  }, [route.params?.emergencyUid, members, focusOn, navigation]);

  const confirmLeave = useCallback(() => {
    Alert.alert('Leave group', 'You will stop sharing your location with this group.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => {
          setSelectedUid(null);
          family.leaveGroup();
        },
      },
    ]);
  }, [family]);

  const openPlaceSheet = useCallback((place) => {
    setEditingPlace(place || null);
    setPlaceSheetOpen(true);
  }, []);

  // ---- sheet sections ----------------------------------------------------
  const renderMember = useCallback(
    ({ item }) =>
      item.__empty ? (
        <EmptyState
          compact
          icon="people-outline"
          title="Nobody is sharing yet"
          body="Share the group code so your family can join. Your own pin appears as soon as your location updates."
        />
      ) : (
        <MemberRow
          member={item}
          isMe={item.uid === uid}
          unit={unit}
          onPress={() => setSelectedUid(item.uid)}
          onLocate={locateMember}
        />
      ),
    [uid, unit, locateMember]
  );

  const renderPlace = useCallback(
    ({ item }) =>
      item.__empty ? (
        <EmptyState
          compact
          icon="bookmark-outline"
          title="No saved places"
          body="Save home, school or work and the map names them instead of showing a street address."
        />
      ) : (
        <SavedPlaceRow place={item} onPress={() => openPlaceSheet(item)} />
      ),
    [openPlaceSheet]
  );

  const sections = useMemo(
    () => [
      {
        key: 'members',
        title: 'Members',
        data: members.length ? members : [{ __empty: 'members' }],
        renderItem: renderMember,
      },
      {
        key: 'places',
        title: 'Saved places',
        data: places.length ? places : [{ __empty: 'places' }],
        renderItem: renderPlace,
      },
    ],
    [members, places, renderMember, renderPlace]
  );

  const keyExtractor = useCallback((item, index) => {
    if (item.uid) return `m-${item.uid}`;
    if (item.__empty) return `empty-${item.__empty}`;
    return `p-${item.name}-${index}`;
  }, []);

  // ---- render ------------------------------------------------------------
  if (profileLoaded && !groupId) {
    return (
      <View style={{ flex: 1, backgroundColor: t.colors.bg, paddingTop: insets.top + 8 }}>
        <JoinCreatePanel
          permissions={perms}
          onCreate={family.createGroup}
          onJoin={family.joinGroup}
        />
      </View>
    );
  }

  const isLoading = !profileLoaded || !loaded;
  const recenterBottom = Math.max(containerHeight * 0.18, 120) + 16;

  return (
    <View
      style={{ flex: 1, backgroundColor: t.colors.bg }}
      onLayout={(e) => setContainerHeight(e.nativeEvent.layout.height)}
    >
      {location ? (
        <MapView
          ref={mapRef}
          style={StyleSheet.absoluteFill}
          initialRegion={{ ...location, ...DELTA }}
          customMapStyle={t.isDark ? DARK_MAP_STYLE : []}
          showsUserLocation
          showsMyLocationButton={false}
          toolbarEnabled={false}
        >
          {members
            .filter((m) => m.uid !== uid && m.coords)
            .map((m) => (
              <MemberMarker
                key={m.uid}
                coordinate={m.coords}
                name={m.name}
                photoURL={m.photoURL}
                emergency={m.emergency}
              />
            ))}
          <MemberMarker
            animatedCoordinate={myCoord}
            title="You"
            name={username || 'You'}
            photoURL={photoURL}
          />
        </MapView>
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: t.colors.bgElevated }]} />
      )}

      <View
        pointerEvents="box-none"
        style={{ position: 'absolute', top: insets.top + 8, left: 16, right: 16, gap: 8 }}
      >
        <EmergencyBanner
          members={members}
          uid={uid}
          onLocate={locateMember}
          onClearMine={family.clearEmergency}
        />
        <PermissionBanners permissions={perms} />
      </View>

      <IconButton
        icon="locate"
        tone="accent"
        size={46}
        label="Recenter the map on my location"
        onPress={recenter}
        disabled={!location}
        style={{
          position: 'absolute',
          right: 16,
          bottom: recenterBottom,
          backgroundColor: t.colors.surface,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.border,
          ...t.elevation.card,
        }}
      />

      <BottomSheet
        ref={sheetRef}
        index={1}
        snapPoints={SNAP_POINTS}
        backgroundStyle={{ backgroundColor: t.colors.bgElevated }}
        handleIndicatorStyle={{ backgroundColor: t.colors.textSubtle }}
        handleStyle={{ height: 28 }}
      >
        {isLoading ? (
          <BottomSheetView style={{ paddingHorizontal: 20, paddingTop: 8, gap: 12 }}>
            <Skeleton width="55%" height={26} />
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={66} radius={t.radius.lg} />
            ))}
          </BottomSheetView>
        ) : (
          <BottomSheetSectionList
            sections={sections}
            keyExtractor={keyExtractor}
            stickySectionHeadersEnabled={false}
            contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 32 }}
            initialNumToRender={8}
            maxToRenderPerBatch={8}
            windowSize={5}
            renderSectionHeader={({ section }) => (
              <Eyebrow style={{ marginTop: 22, marginBottom: 10 }}>{section.title}</Eyebrow>
            )}
            ListHeaderComponent={
              <GroupHeader
                name={groupName}
                code={groupId}
                memberCount={members.length}
                onLeave={confirmLeave}
              />
            }
            ListFooterComponent={
              <View style={{ marginTop: 24, gap: 10 }}>
                <Button title="Add a place" onPress={() => openPlaceSheet(null)} />
                <Pressable
                  onPress={confirmLeave}
                  accessibilityRole="button"
                  accessibilityLabel="Leave this group"
                  style={({ pressed }) => [
                    {
                      borderWidth: 1,
                      borderColor: t.colors.borderStrong,
                      borderRadius: t.radius.md,
                      paddingVertical: 14,
                      alignItems: 'center',
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <Text style={{ color: t.colors.danger, fontSize: 15, fontWeight: '700', letterSpacing: 0.2 }}>
                    Leave group
                  </Text>
                </Pressable>
              </View>
            }
          />
        )}
      </BottomSheet>

      <MemberSheet
        visible={!!selectedMember}
        member={selectedMember}
        isMe={selectedMember?.uid === uid}
        unit={unit}
        onClose={() => setSelectedUid(null)}
        onLocate={locateMember}
      />

      <AddPlaceSheet
        open={placeSheetOpen}
        editing={editingPlace}
        places={places}
        myLocation={location}
        onClose={() => {
          setPlaceSheetOpen(false);
          setEditingPlace(null);
        }}
        onSave={family.savePlace}
        onDelete={family.deletePlace}
      />
    </View>
  );
}
