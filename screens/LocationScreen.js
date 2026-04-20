import React, { useEffect, useState, useContext, useRef, useMemo, useCallback, useLayoutEffect } from "react";
import { StyleSheet, View, Text, TouchableOpacity, TextInput, ActivityIndicator, Alert, Dimensions, ScrollView, Animated, Easing, Keyboard, TouchableWithoutFeedback } from "react-native";
import MapView, { Marker, AnimatedRegion } from "react-native-maps";
import * as Location from "expo-location";
import { getFirestore, doc, getDoc, setDoc, updateDoc, arrayRemove, arrayUnion, onSnapshot, deleteField, collection, getDocs, query, where } from "firebase/firestore";
import { fetchHereAutocomplete } from "../utils/here";
import { auth } from '../utils/firebase';
import { ThemeContext } from "../context/ThemeContext";
import { useTheme, SafeGradient, AutoFitText } from "../theme";
import BottomSheet, { BottomSheetView, BottomSheetSectionList } from "@gorhom/bottom-sheet";
const LinearGradient = SafeGradient;
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import debounce from "lodash.debounce";
import { Ionicons } from "@expo/vector-icons";
import { startLocationUpdates, stopLocationUpdates, updateCachedGroupId } from "../utils/LocationService";
import * as Clipboard from "expo-clipboard"; 
import * as Notifications from "expo-notifications";
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image, Modal } from "react-native";

const db = getFirestore();
const { width, height } = Dimensions.get('window');

function PulseRing() {
  const scale = useRef(new Animated.Value(0.2)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.parallel([
        Animated.sequence([
          Animated.timing(scale, { toValue: 2.5, duration: 1000, useNativeDriver: true }),
          Animated.timing(scale, { toValue: 0.2, duration: 0, useNativeDriver: true }),
        ]),
        Animated.sequence([
          Animated.timing(opacity, { toValue: 0, duration: 1000, useNativeDriver: true }),
          Animated.timing(opacity, { toValue: 1, duration: 0, useNativeDriver: true }),
        ]),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [scale, opacity]);

  return (
    <Animated.View
      style={{
        position: "absolute",
        width: 80,
        height: 80,
        borderRadius: 40,
        backgroundColor: "rgba(255, 58, 48, 0.77)",
        transform: [{ scale }],
        opacity,
      }}
    />
  );
}

function normalizeAddress(addr) {
  if (!addr) return "";

  const directionMap = {
    north: "N",
    south: "S",
    east: "E",
    west: "W",
    northeast: "NE",
    northwest: "NW",
    southeast: "SE",
    southwest: "SW"
  };

  const streetTypeMap = {
    avenue: "Ave",
    place: "Pl",
    street: "St",
    road: "Rd",
    boulevard: "Blvd",
    drive: "Dr",
    court: "Ct",
    lane: "Ln",
    terrace: "Ter",
    parkway: "Pkwy",
    circle: "Cir"
  };

  const stateAbbreviations = {
    "Alabama": "AL",
    "Alaska": "AK",
    "Arizona": "AZ",
    "Arkansas": "AR",
    "California": "CA",
    "Colorado": "CO",
    "Connecticut": "CT",
    "Delaware": "DE",
    "Florida": "FL",
    "Georgia": "GA",
    "Hawaii": "HI",
    "Idaho": "ID",
    "Illinois": "IL",
    "Indiana": "IN",
    "Iowa": "IA",
    "Kansas": "KS",
    "Kentucky": "KY",
    "Louisiana": "LA",
    "Maine": "ME",
    "Maryland": "MD",
    "Massachusetts": "MA",
    "Michigan": "MI",
    "Minnesota": "MN",
    "Mississippi": "MS",
    "Missouri": "MO",
    "Montana": "MT",
    "Nebraska": "NE",
    "Nevada": "NV",
    "New Hampshire": "NH",
    "New Jersey": "NJ",
    "New Mexico": "NM",
    "New York": "NY",
    "North Carolina": "NC",
    "North Dakota": "ND",
    "Ohio": "OH",
    "Oklahoma": "OK",
    "Oregon": "OR",
    "Pennsylvania": "PA",
    "Rhode Island": "RI",
    "South Carolina": "SC",
    "South Dakota": "SD",
    "Tennessee": "TN",
    "Texas": "TX",
    "Utah": "UT",
    "Vermont": "VT",
    "Virginia": "VA",
    "Washington": "WA",
    "West Virginia": "WV",
    "Wisconsin": "WI",
    "Wyoming": "WY"
  };

  const numberMap = {
    first: "1st",
    second: "2nd",
    third: "3rd",
    fourth: "4th",
    fifth: "5th",
    sixth: "6th",
    seventh: "7th",
    eighth: "8th",
    ninth: "9th",
    tenth: "10th",
    eleventh: "11th",
    twelfth: "12th",
    thirteenth: "13th",
    fourteenth: "14th",
    fifteenth: "15th",
    twentieth: "20th",
    thirtieth: "30th",
    fortieth: "40th",
    fiftieth: "50th",
  };

  // lowercase and remove punctuation
  let normalized = addr.toLowerCase().replace(/[.,]/g, "");

  // direction abbreviations
  Object.entries(directionMap).forEach(([word, abbr]) => {
    const regex = new RegExp(`\\b${word}\\b`, "gi");
    normalized = normalized.replace(regex, abbr);
  });

  // street type abbreviations
  Object.entries(streetTypeMap).forEach(([word, abbr]) => {
    const regex = new RegExp(`\\b${word}\\b`, "gi");
    normalized = normalized.replace(regex, abbr);
  });

  // normalize state names to abbreviations
  Object.entries(stateAbbreviations).forEach(([state, abbr]) => {
    const regex = new RegExp(`\\b${state.toLowerCase()}\\b`, "gi");
    normalized = normalized.replace(regex, abbr);
  });

  // remove zip codes 
  normalized = normalized.replace(/\b\d{5}(?:-\d{4})?\b/g, "");

  // no multi spaces
  normalized = normalized.replace(/\s+/g, " ").trim();

  //lowercase all again 
  normalized = normalized.toLowerCase();

  return normalized;
}

function compareAddresses(addr1, addr2, threshold = 0.7) {
  if (!addr1 || !addr2) return false;

  const tokens1 = addr1.split(" ").filter(Boolean);
  const tokens2 = addr2.split(" ").filter(Boolean);

  //exact match
  if (tokens1.join(" ") === tokens2.join(" ")) return true;

  //longest matching sequence in order
  let i = 0, j = 0, matches = 0;

  while (i < tokens1.length && j < tokens2.length) {
    if (tokens1[i] === tokens2[j]) {
      matches++;
      i++;
      j++;
    } else {
      j++;
    }
  }

  // fraction of tokens matched relative to shorter address
  const fractionMatched = matches / Math.min(tokens1.length, tokens2.length);

  return fractionMatched >= threshold;
}

function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371e3; // meters
  const toRad = x => (x * Math.PI) / 180;

  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lon2 - lon1);

  const a =
    Math.sin(Δφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;

  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const CACHE_PREFIX = "addr_";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; 
const CACHE_PURGE_THROTTLE_KEY = "addr_cache_last_purge";
const CACHE_PURGE_THROTTLE_MS = 24 * 60 * 60 * 1000;

async function purgeOldGeocodeCache() {
  try {
    const now = Date.now();
    const lastRun = Number(await AsyncStorage.getItem(CACHE_PURGE_THROTTLE_KEY) || 0);
    if (now - lastRun < CACHE_PURGE_THROTTLE_MS) return; 

    const keys = await AsyncStorage.getAllKeys();
    const addrKeys = keys.filter(k => k.startsWith(CACHE_PREFIX));
    if (!addrKeys.length) {
      await AsyncStorage.setItem(CACHE_PURGE_THROTTLE_KEY, String(now));
      return;
    }

    const pairs = await AsyncStorage.multiGet(addrKeys);
    const toRemove = [];
    for (const [k, v] of pairs) {
      if (!v) { toRemove.push(k); continue; }
      try {
        const parsed = JSON.parse(v);
        const ts = parsed?.ts;
        if (!ts || now - ts > CACHE_TTL_MS) {
          toRemove.push(k);
        }
      } catch {
        toRemove.push(k);
      }
    }

    if (toRemove.length) {
      await AsyncStorage.multiRemove(toRemove);
    }
    await AsyncStorage.setItem(CACHE_PURGE_THROTTLE_KEY, String(now));
  } catch (e) {
    console.warn("Cache purge failed:", e);
  }
}



export default function LocationScreen() {

  const navigation = useNavigation();

  useLayoutEffect(() => {
    navigation.getParent()?.setOptions({
      tabBarStyle: { display: 'none' },
    });

    return () => {
      navigation.getParent()?.setOptions({
        tabBarStyle: {
          display: 'flex',
        },
      });
    };
  }, [navigation]);

  const [loading, setLoading] = useState(true);
  const [groupId, setGroupId] = useState(null);
  const [location, setLocation] = useState(null);
  const [joinCode, setJoinCode] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [members, setMembers] = useState([]);
  const memberProfilesRef = useRef({});
  const [selectedMember, setSelectedMember] = useState(null);
  const [isMemberModalVisible, setMemberModalVisible] = useState(false);
  const [locations, setLocations] = useState([]);
  const [editingLocation, setEditingLocation] = useState(null);
  const [addressSuggestions, setAddressSuggestions] = useState([]);
  const [isFetchingSuggestions, setIsFetchingSuggestions] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const mapRef = useRef(null);
  const lastLocations = useRef({});
  const [myDisplayedAddress, setMyDisplayedAddress] = useState(null);
  const myLastGeocodeRef = useRef({ t: 0, lat: null, lon: null });
  
  const openMemberModal = (member) => {
    setSelectedMember(member);
    setMemberModalVisible(true);
  };

  const closeMemberModal = () => {
    setMemberModalVisible(false);
  };

  const myAnimatedCoord = useRef(
    new AnimatedRegion({
      latitude: 0,
      longitude: 0,
      latitudeDelta: 0.01,
      longitudeDelta: 0.01,
    })
  ).current;

  const bottomSheetRef = useRef(null);
  const snapPoints = useMemo(() => ["15%", "40%", "90%"], []);

  const memberKeyExtractor = useCallback((item, index) => {
    if (item.uid) return `member-${item.uid}`;
    if (item.address) return `loc-${item.name}-${item.address}`;
    return `idx-${index}`;
  }, []);

  const renderMemberItem = useCallback(({ item }) => (
    <TouchableOpacity
      style={{ marginBottom: 10, flexDirection: "row", alignItems: "center" }}
      onPress={() => openMemberModal(item)}
    >
      {item.photoURL ? (
        <LinearGradient
          colors={["#00b386", "#0d3d33"]}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            marginRight: 8,
            justifyContent: "center",
            alignItems: "center",
            overflow: "hidden",
          }}
        >
          <Image
            source={{ uri: item.photoURL }}
            style={{ width: "100%", height: "100%", borderRadius: 20 }}
          />
        </LinearGradient>
      ) : (
        <LinearGradient
          colors={["#00b386", "#0d3d33"]}
          style={{
            width: 40,
            height: 40,
            borderRadius: 20,
            marginRight: 8,
            justifyContent: "center",
            alignItems: "center",
          }}
        >
          <Text style={{ color: "white", fontWeight: "bold" }}>
            {item.name[0]?.toUpperCase()}
          </Text>
        </LinearGradient>
      )}

      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
          <Text style={{ color: textColor, marginRight: 6 }}>
            {item.name} {item.uid === user?.uid ? "(You)" : ""}
          </Text>

          {item.emergency && (
            <View
              style={{
                backgroundColor: "#ff3b30",
                paddingHorizontal: 8,
                paddingVertical: 2,
                borderRadius: 10,
              }}
            >
              <Text style={{ color: "#fff", fontWeight: "bold", fontSize: 12 }}>
                Emergency
              </Text>
            </View>
          )}
          {item.isDriving && (
            <View
              style={{
                backgroundColor: "green",
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 10,
              }}
            >
              <Text style={{ color: "white", fontSize: 12 }}>
                Driving ({((item.coords?.speed ?? 0) * 2.23694).toFixed(1)} mph)
              </Text>
            </View>
          )}
        </View>

        {item.coords && (
          <Text style={{ color: altTextColor, fontSize: 12, marginTop: 3 }}>
            {item.uid === user?.uid
              ? (myDisplayedAddress || "Unknown")
              : (item.displayName ? item.displayName : item.address || "Unknown")}
          </Text>
        )}
      </View>

      {item.coords && (
        <TouchableOpacity
          onPress={() => {
            bottomSheetRef.current?.snapToIndex(0);
            mapRef.current?.animateToRegion(
              {
                latitude: item.coords.latitude,
                longitude: item.coords.longitude,
                latitudeDelta: 0.01,
                longitudeDelta: 0.01,
              },
              500
            );
          }}
          style={{
            padding: 6,
            borderRadius: 20,
            backgroundColor: item.coords?.emergency ? '#ff3b30' : moduleBackground,
            marginLeft: 10,
          }}
        >
          <Ionicons
            name={item.coords?.emergency ? 'location-sharp' : 'location-outline'}
            size={20}
            color={item.coords?.emergency ? '#ffffff' : textColor}
          />
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  ), [textColor, altTextColor, moduleBackground, user?.uid, myDisplayedAddress]);

  const renderLocationItem = useCallback(({ item }) =>
    item.placeholder ? (
      <Text style={{ color: altTextColor, fontStyle: "italic", marginTop: 8 }}>
        No locations yet. Click the button below to add a location.
      </Text>
    ) : (
      <TouchableOpacity
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          padding: 10,
          backgroundColor: moduleBackground,
          borderRadius: 8,
          marginBottom: 8,
          minHeight: 70,
        }}
        onPress={() => {
          setNewLocationName(item.name);
          setNewLocationAddress(item.address);
          setEditingLocation(item);
          addLocationSheetRef.current?.expand();
        }}
      >
        <View style={{ flexShrink: 1 }}>
          <Text style={{ color: titleColor, fontWeight: "bold" }}>
            {item.name}
          </Text>
          <Text style={{ color: altTextColor, fontSize: 12, marginRight: 5, marginTop: 3 }}>
            {item.address}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={24} color={altTextColor} />
      </TouchableOpacity>
    ), [titleColor, altTextColor, moduleBackground]);

  const sectionList = useMemo(() => ([
    { title: "Members", data: members, renderItem: renderMemberItem },
    {
      title: "Locations",
      data: locations.length ? locations : [{ placeholder: true }],
      renderItem: renderLocationItem,
    },
  ]), [members, locations, renderMemberItem, renderLocationItem]);

  const { resolvedTheme } = useContext(ThemeContext);
  const isDark = resolvedTheme === "dark";
  const t = useTheme();

  const backgroundColor = isDark ? "rgba(7,10,12,0.8)" : "rgba(247,249,251,0.85)";
  const bottomSheetBackground = t.colors.surface;
  const moduleBackground = t.colors.surfaceRaised || t.colors.surface;
  const titleColor = t.colors.text;
  const textColor = t.colors.text;
  const altTextColor = t.colors.textMuted;
  const buttonColor = t.colors.accent;
  const sheetGradientTop = t.colors.gradientTop;
  const sheetGradientBottom = t.colors.gradientBottom;

  const user = auth.currentUser;

  const [newLocationName, setNewLocationName] = useState("");
  const [newLocationAddress, setNewLocationAddress] = useState("");
  const addLocationSheetRef = useRef(null);
  const addLocationSnapPoints = useMemo(() => ["90%"], []);

  const route = useRoute();
  const emergencyUid = route.params?.emergencyUid;

  useEffect(() => {
    if (!route.params?.emergencyUid) return;

    const uid = route.params.emergencyUid;
    const member = members.find((m) => m.uid === uid);

    if (member?.coords && mapRef.current) {
      setTimeout(() => {
        bottomSheetRef.current?.snapToIndex(0);
        mapRef.current.animateToRegion(
          {
            latitude: member.coords.latitude,
            longitude: member.coords.longitude,
            latitudeDelta: 0.01,
            longitudeDelta: 0.01,
          },
          3000
        );
      }, 500);
    }
  }, [route.params?.emergencyUid, members]);

  useEffect(() => {
    const ensurePermissions = async () => {
      try {
        let { status: locStatus } = await Location.getForegroundPermissionsAsync();
        if (locStatus !== "granted") {
          const req = await Location.requestForegroundPermissionsAsync();
          locStatus = req.status;
        }

        let { status: bgStatus } = await Location.getBackgroundPermissionsAsync();
        if (bgStatus !== "granted") {
          const req = await Location.requestBackgroundPermissionsAsync();
          bgStatus = req.status;
        }

        let { status: notifStatus } = await Notifications.getPermissionsAsync();
        if (notifStatus !== "granted") {
          const req = await Notifications.requestPermissionsAsync();
          notifStatus = req.status;
        }

        const locationGranted = locStatus === "granted" && bgStatus === "granted";
        const notificationsGranted = notifStatus === "granted";

        if (!locationGranted || !notificationsGranted) {
          Alert.alert(
            "Permissions Required",
            "To use this feature, please enable location and notifications in Settings. This allows your group to see your location and you can recieve alerts when there is an emergency.",
            [
              { text: "OK", onPress: () => navigation.goBack() }
            ]
          );
        }
      } catch (e) {
        console.error("Permission request failed", e);
      }
    };

    ensurePermissions();
  }, [navigation]);


  const copyToClipboard = async (text) => {
    if (!text) return;
    await Clipboard.setStringAsync(text);
    Alert.alert("Copied", "Address copied to clipboard!");
  };

  async function fetchProfilesOnce(uids) {
    
    const chunks = [];
    for (let i = 0; i < uids.length; i += 10) chunks.push(uids.slice(i, i + 10));

    for (const ids of chunks) {
      try {
        const q = query(collection(db, "users"), where("__name__", "in", ids));
        const qs = await getDocs(q);
        qs.forEach(snap => {
          const u = snap.data();
          memberProfilesRef.current[snap.id] = {
            name: u.username || "Member",
            photoURL: u.photoURL || null,
          };
        });
        ids.forEach(id => {
          if (!memberProfilesRef.current[id]) {
            memberProfilesRef.current[id] = { name: "Member", photoURL: null };
          }
        });
      } catch (e) {
        console.error("fetchProfilesOnce failed for", ids, e);
        ids.forEach(id => {
          if (!memberProfilesRef.current[id]) {
            memberProfilesRef.current[id] = { name: "Member", photoURL: null };
          }
        });
      }
    }
  }

  useEffect(() => {
    let sub = null;
    let cancelled = false;
    let runningAnim = null;

    (async () => {
      try {
        const created = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.Balanced,
            distanceInterval: 5,
            timeInterval: 2000,
          },
          (loc) => {
            if (cancelled) return;
            const { latitude, longitude } = loc.coords;
            setLocation({ latitude, longitude });

            runningAnim = myAnimatedCoord.timing({
              latitude,
              longitude,
              duration: 1000,
              useNativeDriver: false,
            });
            runningAnim.start();
          }
        );
        if (cancelled) {
          created?.remove?.();
        } else {
          sub = created;
        }
      } catch (err) {
        console.warn("watchPositionAsync failed:", err);
      }
    })();

    return () => {
      cancelled = true;
      runningAnim?.stop?.();
      sub?.remove?.();
    };
  }, []);


  const [userData, setUserData] = useState(null);


  const openAddLocationSheet = () => {
    addLocationSheetRef.current?.expand();
  };

  const closeAddLocationSheet = () => {
    addLocationSheetRef.current?.close();
  };

  const handleDeleteLocation = async () => {
    if (!groupId || !editingLocation) return;

    Alert.alert(
      "Delete Location",
      "Are you sure you want to remove this location?",
      [
        {
          text: "Cancel",
          style: "cancel"
        },
        {
          text: "Delete",
          style: "destructive",
          onPress: async () => {
            try {
              const groupRef = doc(db, "groups", groupId);

              await updateDoc(groupRef, {
                savedLocations: arrayRemove(editingLocation),
              });

              setLocations(prev =>
                prev.filter(
                  loc =>
                    loc.name !== editingLocation.name || loc.address !== editingLocation.address
                )
              );

              setNewLocationName("");
              setNewLocationAddress("");
              setEditingLocation(null);
              closeAddLocationSheet();

            } catch (error) {
              console.error("Error deleting location:", error);
              Alert.alert("Error", "Could not delete location.");
            }
          }
        }
      ],
      { cancelable: true }
    );
  };


  const handleSaveLocation = async () => {
    if (!newLocationName.trim() || !newLocationAddress.trim()) {
      Alert.alert("Missing Info", "Please provide both a name and address.");
      return;
    }

    try {
      const groupRef = doc(db, "groups", groupId);

      if (editingLocation) {
        await updateDoc(groupRef, {
          savedLocations: arrayRemove(editingLocation)
        });

        setLocations(prev =>
          prev.filter(
            loc =>
              loc.name !== editingLocation.name || loc.address !== editingLocation.address
          )
        );
      } else {
        const nameTaken = locations.some(
          loc => loc.name.trim().toLowerCase() === newLocationName.trim().toLowerCase()
        );
        const addressTaken = locations.some(
          loc => loc.address.trim().toLowerCase() === newLocationAddress.trim().toLowerCase()
        );

        if (nameTaken) {
          Alert.alert("Duplicate Name", "A location with this name already exists.");
          return;
        }
        if (addressTaken) {
          Alert.alert("Duplicate Address", "A location with this address already exists.");
          return;
        }
      }

      const newLoc = {
        name: newLocationName.trim(),
        address: newLocationAddress.trim(),
        createdBy: user.uid
      };

      await updateDoc(groupRef, {
        savedLocations: arrayUnion(newLoc)
      });

      setNewLocationName("");
      setNewLocationAddress("");
      setEditingLocation(null);
      closeAddLocationSheet();

    } catch (error) {
      console.error("Error saving location:", error);
      Alert.alert("Error", "Could not save location.");
    }
  };

  const getAddressForUser = async (uid, data, savedLocations, normalizedSavedLocations) => {
    let address = "Unknown location";

    if (!data.location) return address;

    const speed = data.location.speed || 0;
    const lat = data.location.latitude.toFixed(5);
    const lon = data.location.longitude.toFixed(5);
    const cacheKey = `addr_${lat}_${lon}`;

    // Check cache
    let cachedRaw = await AsyncStorage.getItem(cacheKey);
    if (cachedRaw) {
      try {
        const parsed = JSON.parse(cachedRaw);
        if (parsed && typeof parsed === "object" && parsed.v) {
          address = parsed.v; 
        } else {
          address = cachedRaw;
        }
      } catch {
        address = cachedRaw;
        try {
          await AsyncStorage.setItem(
            cacheKey,
            JSON.stringify({ v: cachedRaw, ts: Date.now() })
          );
        } catch {}
      }
    }

    if (!cachedRaw) {
      try {
        const response = await fetch(
          `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&zoom=18&addressdetails=1`,
          {
            headers: {
              "User-Agent": "RoadCash/1.0 (contact@roadcash.app)",
              "Accept": "application/json",
            },
          }
        );

        if (response.ok) {
          const result = await response.json();
          if (result && result.address) {
            const { road, house_number, city, town, village, state, country } = result.address;
            const addrParts = [
              house_number ? house_number + " " : "",
              road || "",
              city || town || village || state || "",
              country || "",
            ].filter(Boolean);
            address = addrParts.join(" ");
          }
          if (address !== "Unknown location") {
            await AsyncStorage.setItem(
              cacheKey,
              JSON.stringify({ v: address, ts: Date.now() })
            );
          }
        }
      } catch (e) {
        console.warn("Reverse geocode failed:", e);
      }
      await new Promise(res => setTimeout(res, 1000));
    }


    // Check if matches saved location
    const normalized = normalizeAddress(address);
    const match = normalizedSavedLocations.find(loc =>
      compareAddresses(normalized, loc.normalizedAddress)
    );
    return {
      displayName: match ? match.name : null,
      address: address 
    };
  };

  useEffect(() => {
    if (!location || locations.length === 0) return;

    const now = Date.now();
    const last = myLastGeocodeRef.current;

    const dist = (last.lat == null || last.lon == null)
      ? Infinity
      : getDistance(last.lat, last.lon, location.latitude, location.longitude);

    if (last.t && (now - last.t < 10_000 || dist < 10)) return;

    myLastGeocodeRef.current = { t: now, lat: location.latitude, lon: location.longitude };

    const normalizedSavedLocations = locations.map((loc) => ({
      ...loc,
      normalizedAddress: normalizeAddress(loc.address),
    }));

    let cancelled = false;
    getAddressForUser(
      user.uid,
      { location },
      locations,
      normalizedSavedLocations
    ).then((result) => {
      if (cancelled) return;
      setMyDisplayedAddress(result.displayName || result.address || "Unknown");
    });

    return () => { cancelled = true; };
  }, [location, locations]);




  const fadeInContent = useCallback(() => { 
    contentOpacity.setValue(0);
    Animated.timing(contentOpacity, {
      toValue: 1,
      duration: 1000,
      easing: Easing.out(Easing.poly(3)),
      useNativeDriver: true,
    }).start();
  }, [contentOpacity]);

  useFocusEffect(
    useCallback(() => {
      purgeOldGeocodeCache();
    }, [])
  );


  useEffect(() => {
    if (!groupId) return;

    let cancelled = false;
    const groupRef = doc(db, "groups", groupId);
    const pendingAddressFetches = new Set();

    const commitMembers = (memberLocations) => {
      const memberIds = Object.keys(memberLocations);
      setMembers((prev) => {
        const prevMap = new Map(prev.map((m) => [m.uid, m]));
        let changed = false;

        memberIds.forEach((uid) => {
          const coords = memberLocations[uid] || {};
          const profile = memberProfilesRef.current?.[uid];
          const prevItem = prevMap.get(uid);
          const name = profile?.name ?? prevItem?.name ?? coords?.username ?? "Member";
          const photoURL = profile?.photoURL ?? prevItem?.photoURL ?? coords?.photoURL ?? null;

          const nextLat = coords?.latitude ?? prevItem?.coords?.latitude ?? null;
          const nextLng = coords?.longitude ?? prevItem?.coords?.longitude ?? null;
          const nextSpeed = coords?.speed ?? prevItem?.coords?.speed ?? 0;
          const nextUpdatedAt = coords?.updatedAt ?? prevItem?.coords?.updatedAt ?? null;
          const nextEmergency = coords?.emergency ?? prevItem?.coords?.emergency ?? false;
          const nextIsDriving = (nextSpeed ?? 0) > 10;

          let renderCoord = prevItem?.renderCoord;
          if (
            nextLat != null && nextLng != null &&
            (!renderCoord || renderCoord.latitude !== nextLat || renderCoord.longitude !== nextLng)
          ) {
            renderCoord = { latitude: nextLat, longitude: nextLng };
          }

          if (
            prevItem &&
            prevItem.name === name &&
            prevItem.photoURL === photoURL &&
            prevItem.coords?.latitude === nextLat &&
            prevItem.coords?.longitude === nextLng &&
            prevItem.coords?.speed === nextSpeed &&
            prevItem.coords?.updatedAt === nextUpdatedAt &&
            prevItem.coords?.emergency === nextEmergency &&
            prevItem.isDriving === nextIsDriving &&
            prevItem.emergency === nextEmergency &&
            prevItem.renderCoord === renderCoord
          ) {
            return;
          }

          changed = true;
          prevMap.set(uid, {
            uid,
            name,
            photoURL,
            coords: {
              latitude: nextLat,
              longitude: nextLng,
              speed: nextSpeed,
              updatedAt: nextUpdatedAt,
              emergency: nextEmergency,
            },
            renderCoord,
            isDriving: nextIsDriving,
            emergency: nextEmergency,
            displayName: prevItem?.displayName ?? null,
            address: prevItem?.address ?? null,
          });
        });

        for (const oldUid of Array.from(prevMap.keys())) {
          if (!memberIds.includes(oldUid)) {
            prevMap.delete(oldUid);
            changed = true;
          }
        }

        if (!changed) return prev;
        return Array.from(prevMap.values());
      });
    };

    const updateMemberAddress = (uid, address) => {
      if (cancelled) return;
      setMembers((prev) => {
        let changed = false;
        const next = prev.map((m) => {
          if (m.uid !== uid) return m;
          const nextDisplayName = address?.displayName ?? m.displayName ?? null;
          const nextAddress = address?.address ?? m.address ?? null;
          if (m.displayName === nextDisplayName && m.address === nextAddress) return m;
          changed = true;
          return { ...m, displayName: nextDisplayName, address: nextAddress };
        });
        return changed ? next : prev;
      });
    };

    const unsubGroup = onSnapshot(groupRef, (groupSnap) => {
      if (cancelled || !groupSnap.exists()) return;

      const groupData = groupSnap.data();
      const memberLocations = groupData.memberLocations || {};
      const savedLocations = groupData.savedLocations || [];

      setGroupName(groupData.groupName || "");
      setLocations(savedLocations);

      commitMembers(memberLocations);

      const memberIds = Object.keys(memberLocations);
      const missingProfiles = memberIds.filter((id) => !memberProfilesRef.current[id]);
      if (missingProfiles.length > 0) {
        fetchProfilesOnce(missingProfiles).then(() => {
          if (!cancelled) commitMembers(memberLocations);
        });
      }

      const normalizedSavedLocations = savedLocations.map((loc) => ({
        ...loc,
        normalizedAddress: normalizeAddress(loc.address),
      }));

      memberIds.forEach((uid) => {
        const coords = memberLocations[uid];
        if (coords?.latitude == null || coords?.longitude == null) return;

        const last = lastLocations.current?.[uid];
        let shouldFetch = !last;
        if (last) {
          const dist = getDistance(last.latitude, last.longitude, coords.latitude, coords.longitude);
          if (dist >= 10) shouldFetch = true;
        }
        if (!shouldFetch) return;

        const fetchKey = `${uid}:${coords.latitude.toFixed(5)}:${coords.longitude.toFixed(5)}`;
        if (pendingAddressFetches.has(fetchKey)) return;
        pendingAddressFetches.add(fetchKey);

        (lastLocations.current || (lastLocations.current = {}))[uid] = {
          latitude: coords.latitude,
          longitude: coords.longitude,
        };

        getAddressForUser(uid, { location: coords }, savedLocations, normalizedSavedLocations)
          .then((address) => updateMemberAddress(uid, address))
          .catch(() => {})
          .finally(() => pendingAddressFetches.delete(fetchKey));
      });

      if (initialLoad && !cancelled) setInitialLoad(false);
    });

    return () => {
      cancelled = true;
      unsubGroup();
    };
  }, [groupId]);



  //group management logic
  useEffect(() => {
    let cancelled = false;

    const checkGroup = async () => {
      if (!user) return;

      const userRef = doc(db, "users", user.uid);
      const snapshot = await getDoc(userRef);
      if (cancelled) return;

      if (snapshot.exists()) {
        const data = snapshot.data();
        setUserData(data);
        if (data.groupId) setGroupId(data.groupId);
      }
      setLoading(false);
    };

    checkGroup();

    contentOpacity.setValue(0);
    fadeInContent();

    return () => { cancelled = true; };
  }, []);


  const fetchAddressSuggestions = useCallback(async (query) => {
    if (!query.trim()) {
      setAddressSuggestions([]);
      return;
    }

    setIsFetchingSuggestions(true);
    try {
      const items = await fetchHereAutocomplete(query);
      setAddressSuggestions(items);
    } finally {
      setIsFetchingSuggestions(false);
    }
  }, []);

  const debouncedFetch = useMemo(
    () => debounce(fetchAddressSuggestions, 500),
    [fetchAddressSuggestions]
  );

  useEffect(() => {
    return () => {
      debouncedFetch.cancel();
    };
  }, [debouncedFetch]);

  const handleStartCreateGroup = () => setIsCreating(true);

  const handleConfirmCreateGroup = async () => {
    if (!groupName.trim()) {
      Alert.alert("Missing Name", "Please enter a group name.");
      return;
    }

    const newGroupId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const userRef = doc(db, "users", user.uid);

    await setDoc(userRef, { groupId: newGroupId }, { merge: true });
    await updateCachedGroupId(user.uid, newGroupId);

    startLocationUpdates();

    setGroupId(newGroupId);
    setIsCreating(false);
  };

  const handleJoinGroup = async () => {
    if (!joinCode.trim()) return;

    const gid = joinCode.trim().toUpperCase();
    const groupRef = doc(db, "groups", gid);
    const groupSnap = await getDoc(groupRef);

    if (!groupSnap.exists()) {
        Alert.alert("Group Not Found", "The group code you entered does not exist.");
        return;
    }

    const userRef = doc(db, "users", user.uid);

    await setDoc(userRef, { groupId: gid }, { merge: true });
    await updateCachedGroupId(user.uid, gid);

    startLocationUpdates();

   

    const savedLocations = groupSnap.data().savedLocations || [];
    const normalizedSavedLocations = savedLocations.map((loc) => ({
      ...loc,
      normalizedAddress: normalizeAddress(loc.address),
    }));

    const { coords } = await Location.getCurrentPositionAsync({});

    const myAddress = await getAddressForUser(
      user.uid,
      { location: { latitude: coords.latitude, longitude: coords.longitude, speed: coords.speed ?? 0 } },
      savedLocations,
      normalizedSavedLocations
    );

     

    setMembers((prev) => [
      ...prev.filter((m) => m.uid !== user.uid),
      {
        uid: user.uid,
        name: user.displayName || "You",
        photoURL: user.photoURL || null,
        coords: { latitude: coords.latitude, longitude: coords.longitude, speed: coords.speed ?? 0 },
        renderCoord: { latitude: coords.latitude, longitude: coords.longitude },
        isDriving: (coords.speed ?? 0) > 10,
        emergency: false,
        address: myAddress?.displayName || myAddress?.address || "Unknown"
      },
    ]);

    setGroupId(gid);
  };

  const confirmLeaveGroup = () => {
    Alert.alert(
      "Leave Group",
      "Are you sure you want to leave this group?",
      [
        {
          text: "Cancel",
          style: "cancel"
        },
        {
          text: "Leave",
          style: "destructive",
          onPress: handleLeaveGroup
        }
      ],
      { cancelable: true }
    );
  };

  const handleLeaveGroup = async () => {
    if (!groupId || !user) return;

    const userRef = doc(db, "users", user.uid);
    const groupRef = doc(db, "groups", groupId);

    await setDoc(userRef, { groupId: null }, { merge: true });
    await updateCachedGroupId(user.uid, null);

    await updateDoc(groupRef, {
      [`memberLocations.${user.uid}`]: deleteField(),
    });

    setGroupId(null);

    stopLocationUpdates();
  };

  const fillAddressFromOnscreen = async () => {
    if (!location?.latitude || !location?.longitude) return;

    const lat = location.latitude;
    const lon = location.longitude;

    const cached = await getCachedAddressNear(lat, lon, 0.00005);

    if (cached) {
      setNewLocationAddress(cached);
      setAddressSuggestions([]);
    } else {
      setNewLocationAddress(""); 
    }
  };

  const getCachedAddressNear = async (lat, lon, tolerance = 0.00005) => {
    const keys = await AsyncStorage.getAllKeys();
    const addrKeys = keys.filter((k) => k.startsWith(CACHE_PREFIX)); 

    for (const key of addrKeys) {
      const [, keyLat, keyLon] = key.split("_");
      const kLat = parseFloat(keyLat);
      const kLon = parseFloat(keyLon);

      if (Math.abs(lat - kLat) <= tolerance && Math.abs(lon - kLon) <= tolerance) {
        const raw = await AsyncStorage.getItem(key);
        if (!raw) continue;

        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object" && parsed.v) return parsed.v; 
        } catch {
          return raw; 
        }
      }
    }
    return null;
  };



  const nameInputRef = useRef(null);
  const addressInputRef = useRef(null);

  const background = useCallback((props) => (
    <LinearGradient
      colors={[sheetGradientTop, sheetGradientBottom]}
      style={[
        { flex: 1, borderTopLeftRadius: 20, borderTopRightRadius: 20 },
        props.style,
      ]}
    />
  ), [sheetGradientTop, sheetGradientBottom]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="small" />
      </View>
    );
  }

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
    <Animated.View style={{ flex: 1, opacity: contentOpacity }}>
    <GestureHandlerRootView style={{ flex: 1 }}>
      <View style={styles.container}>
        {location && (
            <MapView
              ref={mapRef}
                style={styles.map}
                initialRegion={{
                latitude: location.latitude,
                longitude: location.longitude,
                latitudeDelta: 0.01,
                longitudeDelta: 0.01,
                }}
              showsUserLocation={true}
            >
              

              {members
                .filter(member => member.uid !== user.uid && member.coords)
                .map(member => (
                    <Marker
                      key={member.uid}
                      coordinate={{
                        latitude: member.coords.latitude,
                        longitude: member.coords.longitude,
                      }}
                      title={member.name}
                      tracksViewChanges={false} 
                    >
                      <View style={{ width: 50, height: 50, alignItems: 'center', marginBottom: 50 }}>
                        {member.emergency && <PulseRing />}
                        <Image
                          source={require('../assets/marker.png')}
                          style={{ width: 50, height: 50 }}
                          resizeMode="contain"
                        />

                        <Image
                          source={ member.photoURL ? { uri: member.photoURL } : null }
                          style={{
                            width: 30,
                            height: 30,
                            borderRadius: 15,
                            position: 'absolute',
                            top: 3, 
                            
                          }}
                        />
                        
                        {!member.photoURL && (
                          <View
                            style={{
                              width: 30,
                              height: 30,
                              borderRadius: 15,
                              backgroundColor: '#666',
                              position: 'absolute',
                              top: 3,
                              justifyContent: 'center',
                              alignItems: 'center',
                            }}
                          >
                            <Text style={{ color: 'white', fontWeight: 'bold' }}>
                              {member.name[0].toUpperCase()}
                            </Text>
                          </View>
                        )}
                      </View>
                    </Marker>
                )
              )}

              {location && (
                <Marker.Animated coordinate={myAnimatedCoord} title="You" tracksViewChanges={false}>
                  <View style={{ width: 50, height: 50, alignItems: 'center', marginBottom: 50 }}>
                    <Image
                      source={require('../assets/marker.png')}
                      style={{ width: 50, height: 50 }}
                      resizeMode="contain"
                    />

                    {userData?.photoURL ? (
                      <Image
                        source={{ uri: userData.photoURL }}
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 15,
                          position: 'absolute',
                          top: 3,
                        }}
                      />
                    ) : (
                      <View
                        style={{
                          width: 30,
                          height: 30,
                          borderRadius: 15,
                          backgroundColor: '#666',
                          position: 'absolute',
                          top: 3,
                          justifyContent: 'center',
                          alignItems: 'center',
                        }}
                      >
                        <Text style={{ color: 'white', fontWeight: 'bold' }}>
                          {user.username?.[0]?.toUpperCase() ?? 'Me'}
                        </Text>
                      </View>
                    )}
                  </View>
                </Marker.Animated>
              )}
            </MapView>
        )}


        {!groupId && !isCreating && (
          <View style={[styles.joinPanelNew, { backgroundColor: t.colors.bg }]}>
            <Text
              style={[
                t.typography.micro,
                { color: t.colors.accent, marginBottom: 10 },
              ]}
            >
              Family Safety
            </Text>
            <Text style={[t.typography.title, { color: titleColor, marginBottom: 8 }]}>
              RoadCash Groups
            </Text>
            <Text
              style={[
                t.typography.body,
                { color: altTextColor, marginBottom: 24, maxWidth: 320 },
              ]}
            >
              Stay connected with the drivers who matter. Create a group, or join one with a code.
            </Text>

            <View
              style={{
                width: "100%",
                backgroundColor: t.colors.surface,
                borderRadius: t.radius.lg,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: t.colors.border,
                padding: 20,
                marginBottom: 16,
              }}
            >
              <Text
                style={[
                  t.typography.micro,
                  {
                    color: t.colors.textMuted,
                    textTransform: "uppercase",
                    letterSpacing: 1.1,
                    marginBottom: 12,
                  },
                ]}
              >
                Create new
              </Text>
              <TouchableOpacity
                style={{
                  backgroundColor: buttonColor,
                  paddingVertical: 14,
                  borderRadius: t.radius.md,
                  alignItems: "center",
                }}
                onPress={handleStartCreateGroup}
              >
                <Text style={{ color: t.colors.accentText, fontWeight: "700", fontSize: 15 }}>
                  Create group
                </Text>
              </TouchableOpacity>
            </View>

            <View
              style={{
                width: "100%",
                backgroundColor: t.colors.surface,
                borderRadius: t.radius.lg,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: t.colors.border,
                padding: 20,
              }}
            >
              <Text
                style={[
                  t.typography.micro,
                  {
                    color: t.colors.textMuted,
                    textTransform: "uppercase",
                    letterSpacing: 1.1,
                    marginBottom: 12,
                  },
                ]}
              >
                Join existing
              </Text>
              <TextInput
                style={{
                  backgroundColor: t.colors.surfaceAlt,
                  borderWidth: 1,
                  borderColor: t.colors.border,
                  borderRadius: t.radius.md,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  color: textColor,
                  fontSize: 15,
                  letterSpacing: 2,
                  marginBottom: 12,
                }}
                placeholder="GROUP CODE"
                placeholderTextColor={t.colors.textSubtle}
                value={joinCode}
                autoCapitalize="characters"
                onChangeText={(text) => setJoinCode(text.toUpperCase())}
              />
              <TouchableOpacity
                style={{
                  backgroundColor: "transparent",
                  borderWidth: 1,
                  borderColor: t.colors.borderStrong,
                  paddingVertical: 14,
                  borderRadius: t.radius.md,
                  alignItems: "center",
                }}
                onPress={handleJoinGroup}
              >
                <Text style={{ color: t.colors.text, fontWeight: "700", fontSize: 15 }}>
                  Join group
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {!groupId && isCreating && (
          <View style={[styles.joinPanelNew, { backgroundColor: t.colors.bg }]}>
            <Text
              style={[
                t.typography.micro,
                { color: t.colors.accent, marginBottom: 10 },
              ]}
            >
              New group
            </Text>
            <Text style={[t.typography.title, { color: titleColor, marginBottom: 24 }]}>
              Name your group
            </Text>

            <View
              style={{
                width: "100%",
                backgroundColor: t.colors.surface,
                borderRadius: t.radius.lg,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: t.colors.border,
                padding: 20,
              }}
            >
              <TextInput
                style={{
                  backgroundColor: t.colors.surfaceAlt,
                  borderWidth: 1,
                  borderColor: t.colors.border,
                  borderRadius: t.radius.md,
                  paddingHorizontal: 14,
                  paddingVertical: 12,
                  color: textColor,
                  fontSize: 15,
                  marginBottom: 14,
                }}
                placeholder="Group name"
                placeholderTextColor={t.colors.textSubtle}
                value={groupName}
                onChangeText={setGroupName}
              />

              <TouchableOpacity
                style={{
                  backgroundColor: buttonColor,
                  paddingVertical: 14,
                  borderRadius: t.radius.md,
                  alignItems: "center",
                  marginBottom: 10,
                }}
                onPress={handleConfirmCreateGroup}
              >
                <Text style={{ color: t.colors.accentText, fontWeight: "700", fontSize: 15 }}>
                  Confirm
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={{
                  backgroundColor: "transparent",
                  borderWidth: 1,
                  borderColor: t.colors.borderStrong,
                  paddingVertical: 14,
                  borderRadius: t.radius.md,
                  alignItems: "center",
                }}
                onPress={() => setIsCreating(false)}
              >
                <Text style={{ color: t.colors.text, fontWeight: "700", fontSize: 15 }}>
                  Cancel
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {groupId && (
          <BottomSheet
            ref={bottomSheetRef}
            index={1} 
            snapPoints={snapPoints}
            backgroundComponent={background}
            handleIndicatorStyle={{ backgroundColor: altTextColor }}
            handleStyle={{
                height: 32,
                backgroundColor: "transparent",
            }}
          >
              {initialLoad ? (
                <View style={{ flex: 1, justifyContent: "center", alignItems: "center", height: 200 }}>
                  <ActivityIndicator size="small" color={altTextColor} />
                </View>
              ) : (
              <BottomSheetSectionList
                stickySectionHeadersEnabled={false}
                contentContainerStyle={{ paddingHorizontal: 24 }}
                sections={sectionList}
                keyExtractor={memberKeyExtractor}
                removeClippedSubviews
                initialNumToRender={8}
                maxToRenderPerBatch={8}
                windowSize={5}
                renderSectionHeader={({ section: { title } }) => (
                  <Text
                    style={[
                      t.typography.micro,
                      {
                        color: t.colors.accent,
                        marginTop: 22,
                        marginBottom: 10,
                        letterSpacing: 1.2,
                      },
                    ]}
                  >
                    {title}
                  </Text>
                )}
                ListHeaderComponent={
                  <View style={{ marginTop: 4, marginBottom: 4 }}>
                    <Text
                      style={[
                        t.typography.micro,
                        { color: t.colors.accent, marginBottom: 6 },
                      ]}
                    >
                      Group
                    </Text>
                    <Text style={[t.typography.title, { color: titleColor }]}>
                      {groupName}
                    </Text>
                  </View>
                }
                ListFooterComponent={
                  <View style={{ marginTop: 24, marginBottom: 32 }}>
                    <TouchableOpacity
                      style={{
                        backgroundColor: buttonColor,
                        paddingVertical: 14,
                        borderRadius: t.radius.md,
                        alignItems: "center",
                        marginBottom: 12,
                      }}
                      onPress={openAddLocationSheet}
                    >
                      <Text style={{ color: t.colors.accentText, fontWeight: "700", fontSize: 15 }}>
                        Add a location
                      </Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={{
                        backgroundColor: t.colors.danger,
                        paddingVertical: 14,
                        borderRadius: t.radius.md,
                        alignItems: "center",
                      }}
                      onPress={confirmLeaveGroup}
                    >
                      <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>
                        Leave group
                      </Text>
                    </TouchableOpacity>
                  </View>
                }
              />
              )}

              {selectedMember && (
                <Modal
                  visible={isMemberModalVisible}
                  transparent={true}
                  animationType="fade"
                  onRequestClose={closeMemberModal}
                  onDismiss={() => setSelectedMember(null)}
                >
                  <View style={{
                    flex: 1,
                    backgroundColor: "rgba(0,0,0,0.5)",
                    justifyContent: "center",
                    alignItems: "center",
                  }}>
                    <View style={{
                      backgroundColor: bottomSheetBackground,
                      padding: 20,
                      borderRadius: 12,
                      width: "85%"
                    }}>
                      <Text style={{ fontSize: 20, fontWeight: "bold", color: titleColor }}>
                        {selectedMember.name}
                      </Text>

                      {selectedMember.coords && (
                        <>
                          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12, marginBottom: 8 }}>
                            <Text style={{ color: textColor, flex: 1, fontSize: 15 }}>
                              Location: {selectedMember.address}
                            </Text>
                            {selectedMember.address && (
                              <TouchableOpacity onPress={() => copyToClipboard(selectedMember.address)}>
                                <Ionicons name="copy-outline" size={22} color={textColor} style={{ marginLeft: 8, marginRight: 12 }} />
                              </TouchableOpacity>
                            )}
                          </View>
                          <Text style={{ color: textColor, marginBottom: 8, fontSize: 15 }}>
                            Last Updated:{" "}
                            {selectedMember.coords.updatedAt
                              ? new Date(selectedMember.coords.updatedAt.seconds * 1000).toLocaleString()
                              : "N/A"}
                          </Text>
                          <Text style={{ color: textColor, marginBottom: 8, fontSize: 15 }}>
                            Speed: {((selectedMember.coords.speed ?? 0) * 2.23694).toFixed(0)} mph
                          </Text>
                        </>
                      )}

                      <TouchableOpacity
                        onPress={closeMemberModal}
                        style={{
                          marginTop: 20,
                          backgroundColor: buttonColor,
                          paddingVertical: 10,
                          borderRadius: 8,
                          alignItems: "center",
                        }}
                      >
                        <Text style={{ color: "white", fontWeight: "bold" }}>Close</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </Modal>
              )}

          </BottomSheet>
          
        )}
        {/* Add Location */}
        <BottomSheet
          ref={addLocationSheetRef}
          index={-1}
          snapPoints={addLocationSnapPoints}
          backgroundStyle={{ backgroundColor: bottomSheetBackground }}
          handleIndicatorStyle={{ backgroundColor: altTextColor }}
          handleComponent={null}
          enablePanDownToClose={false}  
          enableContentPanningGesture={false} 
          enableHandlePanningGesture={false}
        >
          <BottomSheetView style={{ flex: 1, padding: 20 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <TouchableOpacity onPress={() => {
                nameInputRef.current?.blur();
                addressInputRef.current?.blur();
                Keyboard.dismiss();
                closeAddLocationSheet();
                setNewLocationName("");
                setNewLocationAddress("");
                setAddressSuggestions([]);
              }}
              >
                <Text style={{ color: buttonColor, fontSize: 16 }}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress= {() => {
                nameInputRef.current?.blur();
                addressInputRef.current?.blur();
                Keyboard.dismiss();
                handleSaveLocation();
              }}
              
              >
                <Text style={{ color: buttonColor, fontWeight: "bold", fontSize: 16 }}>Save</Text>
              </TouchableOpacity>
            </View>

            <Text style={[styles.label, { color: textColor, marginTop: 30, fontWeight: "bold", fontSize: 20 }]}>Location Name</Text>
            <TextInput
              style={[styles.input, { color: textColor, width: "100%", textAlign: "left", borderColor: altTextColor  }]}
              placeholder="e.g. Home, Office"
              placeholderTextColor={altTextColor}
              value={newLocationName}
              onChangeText={setNewLocationName}
              ref={nameInputRef}
            />

            <Text style={[styles.label, { color: textColor, marginTop: 20, fontWeight: "bold", fontSize: 20 }]}>Address</Text>
            <TextInput
              style={[styles.input, { color: textColor, width: "100%", textAlign: "left", borderColor: altTextColor }]}
              placeholder="Address"
              placeholderTextColor={altTextColor}
              value={newLocationAddress}
              ref={addressInputRef}
              onChangeText={(text) => {
                setNewLocationAddress(text);
                debouncedFetch(text);
              }}
            />
            <TouchableOpacity
              onPress={fillAddressFromOnscreen}
              style={{ marginTop: 8, alignSelf: "flex-start" }}
            >
              <Text style={{ color: buttonColor, textDecorationLine: "underline" }}>
                Use my current location
              </Text>
            </TouchableOpacity>
            {isFetchingSuggestions && (
              <ActivityIndicator size="small" color={titleColor} style={{ marginTop: 10 }} />
            )}

            {addressSuggestions.length > 0 && (
              <ScrollView
                style={{
                  maxHeight: height/3,
                  marginTop: 10,
                  borderWidth: 1,
                  borderColor: "#8080805e",
                  borderRadius: 8,
                  backgroundColor: isDark ? "#0c0c0cff" : "#fff",
                }}
              >
                {addressSuggestions.map((s, idx) => (
                  <TouchableOpacity
                    key={idx}
                    style={{ padding: 10, borderBottomWidth: 1, borderBottomColor: "#8080805e" }}
                    onPress={() => {
                      setNewLocationAddress(s.address.label || s.title); 
                      setAddressSuggestions([]); 
                    }}
                  >
                    <Text style={{ color: textColor }}>{s.address.label || s.title}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}

            {locations.some(
              loc =>
                loc.name === newLocationName && loc.address === newLocationAddress
            ) && (
              <TouchableOpacity
                style={{
                  marginTop: 20,
                  backgroundColor: "#ff2626ff",
                  paddingVertical: 12,
                  borderRadius: 10,
                  alignItems: "center",
                }}
                onPress={handleDeleteLocation}
              >
                <Text style={{ color: "white", fontWeight: "bold" }}>Delete Location</Text>
              </TouchableOpacity>
            )}
          </BottomSheetView>
        </BottomSheet>

      </View>
    </GestureHandlerRootView>
    </Animated.View>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },

  joinPanel: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: "100%",
    paddingHorizontal: width / 30,
    paddingVertical: height / 6,
    alignItems: "center",
    justifyContent: "flex-start",
  },
  joinPanelNew: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 24,
    paddingTop: height / 8,
    alignItems: "flex-start",
    justifyContent: "flex-start",
  },

  title: { fontSize: 28, fontWeight: "bold", marginBottom: 15, marginTop: -10 },
  subtitle: { fontSize: 20, fontWeight: "bold", marginBottom: 10, marginTop: 5 },

  starttitle: { fontSize: 32, fontWeight: "bold", fontFamily: "Arial Rounded MT Bold", marginBottom: 25 },
  startsubtitle: { fontSize: 20, fontWeight: "bold", fontFamily: "Arial Rounded MT Bold", marginBottom: 10, marginTop: 5 },
  orText: { marginVertical: 10, fontSize: 16 },

  button: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    marginTop: 10,
    width: "90%",
    alignItems: "center",
    alignSelf: "center"
  },
  buttonText: { color: "white", fontWeight: "bold" },

  cancelButton: {
    backgroundColor: "#686868ff",
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 10,
    marginTop: 10,
    width: "90%",
    alignItems: "center",
  },

  input: {
    borderWidth: 1,
    borderColor: "#ccc",
    borderRadius: 10,
    padding: 10,
    width: "90%",
    marginTop: 10,
    textAlign: "center",
  },

  center: { flex: 1, justifyContent: "center", alignItems: "center" },
});
