//DriveScreen
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  AppState,
  Alert,
  Animated,
  ImageBackground,
  Dimensions,
  TouchableOpacity,
  Linking,
  ActivityIndicator
} from 'react-native';
import * as Location from 'expo-location';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { BlurView } from 'expo-blur';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { auth } from '../utils/firebase';
import { getFirestore, doc, updateDoc, increment, setDoc, getDoc, serverTimestamp } from 'firebase/firestore';
import { saveTrustedContacts, getTrustedContacts, saveDriveMetrics, startDriving, stopDriving } from '../utils/firestore';
import { fetchHereRevGeocode } from '../utils/here';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { useContext } from 'react';
import { ThemeContext } from '../context/ThemeContext';
import { useTheme, SafeGradient, AutoFitText } from '../theme';
import { setAudioModeAsync, useAudioPlayer } from 'expo-audio';
import { scheduleDistractedNotification, scheduleFirstDistractedNotification, requestNotificationPermissions } from '../utils/notifications';
import { format } from 'date-fns';
import { useDrive } from '../context/DriveContext';
import * as Speech from 'expo-speech';
const LinearGradient = SafeGradient;
import { fetchWeather, getWeatherIconName } from '../utils/weather';
import { MaterialCommunityIcons } from "@expo/vector-icons";
import { getRoadConditionSummary } from "../utils/gptApi";


const db = getFirestore();

const { width, height } = Dimensions.get('window');

const weatherCodeMap = {
  0: { label: "Clear sky", icon: "weather-sunny" },
  1: { label: "Mostly clear", icon: "weather-sunny" },
  2: { label: "Partly cloudy", icon: "weather-partly-cloudy" },
  3: { label: "Overcast", icon: "weather-cloudy" },
  45: { label: "Fog", icon: "weather-fog" },
  48: { label: "Depositing rime fog", icon: "weather-fog" },
  51: { label: "Light drizzle", icon: "weather-rainy" },
  53: { label: "Moderate drizzle", icon: "weather-rainy" },
  55: { label: "Dense drizzle", icon: "weather-rainy" },
  61: { label: "Slight rain", icon: "weather-pouring" },
  63: { label: "Moderate rain", icon: "weather-pouring" },
  65: { label: "Heavy rain", icon: "weather-pouring" },
  71: { label: "Slight snow fall", icon: "weather-snowy" },
  73: { label: "Moderate snow fall", icon: "weather-snowy" },
  75: { label: "Heavy snow fall", icon: "weather-snowy" },
  80: { label: "Light rain showers", icon: "weather-rainy" },
  81: { label: "Moderate rain showers", icon: "weather-rainy" },
  82: { label: "Heavy rain showers", icon: "weather-rainy" },
  95: { label: "Thunderstorm (slight/moderate)", icon: "weather-lightning" },
  96: { label: "Thunderstorm with slight hail", icon: "weather-lightning" },
  99: { label: "Thunderstorm with heavy hail", icon: "weather-lightning" },
};

export function getWeatherInfo(code) {
  return (
    weatherCodeMap[code] || { label: "Unknown", icon: "weather-cloudy-alert" }
  );
}

// Theme-aligned severity palette: safe (accent/teal) → caution (warning/amber) → alert (danger/red)
function severityColor(level, t) {
  // level: 0 safe, 1 caution-light, 2 caution, 3 alert, 4 severe
  switch (level) {
    case 0: return t.colors.accent;
    case 1: return t.colors.accentMuted;
    case 2: return t.colors.warning;
    case 3: return t.colors.danger;
    case 4: return t.colors.danger;
    default: return t.colors.textMuted;
  }
}

function getVisibilityColor(visibilityMeters, t) {
  const miles = visibilityMeters / 1609;
  if (miles < 0.25) return severityColor(3, t);
  if (miles < 1)    return severityColor(2, t);
  if (miles >= 2)   return severityColor(0, t);
  return severityColor(2, t);
}

function getPrecipitationColor(valueInInches, t) {
  if (valueInInches < 0.1) return severityColor(0, t);
  if (valueInInches < 0.2) return severityColor(1, t);
  if (valueInInches < 0.4) return severityColor(2, t);
  return severityColor(3, t);
}

function getRoadBorderColor(score, t) {
  switch (score) {
    case 5: return severityColor(0, t);
    case 4: return severityColor(1, t);
    case 3: return severityColor(2, t);
    case 2: return severityColor(3, t);
    case 1: return severityColor(3, t);
    default: return t?.colors?.divider || "#888";
  }
}

function getRoadIcon(score) {
  switch (score) {
    case 5: return { name: "shield-check", level: 0 };
    case 4: return { name: "shield-check-outline", level: 1 };
    case 3: return { name: "alert-outline", level: 2 };
    case 2: return { name: "alert", level: 3 };
    case 1: return { name: "alert-octagon", level: 3 };
    default: return { name: "help-circle-outline", level: -1 };
  }
}

const AnimatedImageBackground = Animated.createAnimatedComponent(ImageBackground);
const GRID_RESOLUTION = 0.002;
const speedLimitCache = new Map();
let lastSpeedLimitFetchTime = 0;
let lastSpeedLimitFetchCoords = null;

const audioSource = require('../assets/sounds/alert.mp3');

function getGridKey(lat, lon) {
  return `${Math.round(lat / GRID_RESOLUTION)}_${Math.round(lon / GRID_RESOLUTION)}`;
}

async function loadSpeedLimitCache() {
  try {
    const cached = await AsyncStorage.getItem('@speedLimitCache');
    if (!cached) return;
    const entries = JSON.parse(cached);
    for (const [key, val] of entries) {
      if (val && typeof val === 'object' && 'valueKph' in val) {
        speedLimitCache.set(key, val);
      } else if (typeof val === 'number') {
        speedLimitCache.set(key, { valueKph: val * 1.60934, timestamp: Date.now() });
      } else if (val && typeof val === 'object' && 'value' in val && 'unit' in val) {
        const kph = val.unit === 'mph' ? val.value * 1.60934 : val.value;
        speedLimitCache.set(key, { valueKph: kph, timestamp: Date.now(), street: val.street });
      }
    }
  } catch (err) {
    console.warn('⚠️ Failed to load speed limit cache:', err);
  }
}

async function saveSpeedLimitCache() {
  try {
    await AsyncStorage.setItem('@speedLimitCache', JSON.stringify(Array.from(speedLimitCache.entries())));
  } catch (err) {
    console.warn('⚠️ Failed to save speed limit cache:', err);
  }
}

function getDistanceFromLatLonInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; 
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) *
    Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; 
}

function toRad(d){ return d * Math.PI / 180; }
function toDeg(r){ return r * 180 / Math.PI; }

function haversineM(a,b){
  return getDistanceFromLatLonInMeters(a.latitude, a.longitude, b.latitude, b.longitude);
}
function bearingDeg(a,b){
  const φ1 = toRad(a.latitude), φ2 = toRad(b.latitude);
  const Δλ = toRad(b.longitude - a.longitude);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(Δλ);
  return (toDeg(Math.atan2(y,x)) + 360) % 360;
}
function offsetPoint(lat, lon, bearing, distM){
  const R=6371000, br=toRad(bearing), lat1=toRad(lat), lon1=toRad(lon), dr=distM/R;
  const lat2 = Math.asin(Math.sin(lat1)*Math.cos(dr) + Math.cos(lat1)*Math.sin(dr)*Math.cos(br));
  const lon2 = lon1 + Math.atan2(Math.sin(br)*Math.sin(dr)*Math.cos(lat1), Math.cos(dr)-Math.sin(lat1)*Math.sin(lat2));
  return { latitude: toDeg(lat2), longitude: toDeg(lon2) };
}

const FILL_STEP_M = 80;
const FILL_WIDTH_M = 30;
async function fillCachePolyline(points, valueKph, street){
  if (!points || points.length < 2) return;
  for (let s = 0; s < points.length - 1; s++){
    const a = points[s], b = points[s+1];
    const d = haversineM(a,b);
    if (!isFinite(d) || d < 1) continue;
    const steps = Math.max(1, Math.ceil(d / FILL_STEP_M));
    const brg = bearingDeg(a,b);
    for (let i = 0; i <= steps; i++){
      const p = offsetPoint(a.latitude, a.longitude, brg, i * (d/steps));
      const key = getGridKey(p.latitude, p.longitude);
      if (!speedLimitCache.has(key)){
        speedLimitCache.set(key, { valueKph, timestamp: Date.now(), street });
      }
      if (FILL_WIDTH_M > 0){
        const left  = offsetPoint(p.latitude, p.longitude, (brg+270)%360, FILL_WIDTH_M);
        const right = offsetPoint(p.latitude, p.longitude, (brg+90)%360,  FILL_WIDTH_M);
        for (const q of [left, right]){
          const k2 = getGridKey(q.latitude, q.longitude);
          if (!speedLimitCache.has(k2)){
            speedLimitCache.set(k2, { valueKph, timestamp: Date.now(), street });
          }
        }
      }
    }
  }
  await saveSpeedLimitCache();
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3
    ? h.split('').map(c => c + c).join('')
    : h.length === 8 ? h.slice(0, 6) : h;
  const n = parseInt(v, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mix(a, b, t) {
  return {
    r: Math.round(a.r + (b.r - a.r) * t),
    g: Math.round(a.g + (b.g - a.g) * t),
    b: Math.round(a.b + (b.b - a.b) * t),
  };
}

function interpolateColor(speed, limit, themeColors) {
  const safe   = themeColors ? hexToRgb(themeColors.accent)  : { r: 0,   g: 179, b: 134 };
  const warn   = themeColors ? hexToRgb(themeColors.warning) : { r: 230, g: 160, b: 30 };
  const alert  = themeColors ? hexToRgb(themeColors.danger)  : { r: 224, g: 46,  b: 36 };

  if (!isFinite(limit) || limit <= 0) {
    return `rgb(${safe.r},${safe.g},${safe.b})`;
  }

  const percent = Math.max(0, Math.min(1, (speed - limit) / (limit * 0.4)));
  const c = percent <= 0.5
    ? mix(safe, warn, percent / 0.5)
    : mix(warn, alert, (percent - 0.5) / 0.5);
  return `rgb(${c.r},${c.g},${c.b})`;
}

function isRoadSlippery(weather) {
  const tempF = weather.current.temperature_2m; 
  const precip = weather.current.precipitation; 
  const code = weather.current.weathercode;

  if (tempF <= 32 && precip > 0) return true;

  if ([71, 73, 75].includes(code)) return true;

  if (precip > 0.4) return true;

  return false;
}

function getAirQualityColor(aqi, t) {
  if (aqi == null) return t?.colors?.textMuted || "#888";
  if (aqi <= 50)  return severityColor(0, t);
  if (aqi <= 100) return severityColor(1, t);
  if (aqi <= 150) return severityColor(2, t);
  if (aqi <= 200) return severityColor(3, t);
  if (aqi <= 300) return severityColor(3, t);
  return severityColor(4, t);
}

function getAirQualityLabel(aqi) {
  if (aqi <= 50) return "Good";
  if (aqi <= 100) return "Moderate";
  if (aqi <= 150) return "Unhealthy (Sensitive)";
  if (aqi <= 200) return "Unhealthy";
  if (aqi <= 300) return "Very Unhealthy";
  return "Hazardous";
}


function hasSignificantChange(prev, curr) {
  if (!prev) return true; 

  const visChange = Math.abs(curr.visibility - prev.visibility) / 1609; 
  const precipChange = Math.abs(curr.precipitation - prev.precipitation);
  const chanceChange = Math.abs(curr.precipitation_probability - prev.precipitation_probability);
  const windChange = Math.abs(curr.windspeed_10m - prev.windspeed_10m);
  const aqChange = Math.abs(curr.airQuality?.current?.us_aqi - prev.airQuality?.current?.us_aqi)

  return (
    (visChange > 0.5 && prev.visibility <= 2.5) ||
    (visChange > 1 && prev.visibility <= 5) ||
    (visChange > 5 && prev.visibility <= 25) ||
    (visChange > 10 && prev.visibility > 25) ||
    precipChange > 0.05 ||
    chanceChange > 10 ||
    windChange > 5 ||
    aqChange > 25
  );  
}

function getAdaptiveGridKey(lat, lon, speed) {
  const res = speed > 50 ? 0.005 : 0.001; 
  return `${Math.round(lat / res)}_${Math.round(lon / res)}_${res}`;
}

export default function DriveScreen({ route }) {
  const player = useAudioPlayer(audioSource);
  const navigation = useNavigation();
  const [pointsThisDrive, setPointsThisDrive] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [unit, setUnit] = useState('mph');
  const [speedLimit, setSpeedLimit] = useState(null);
  const [showSpeedingWarning, setShowSpeedingWarning] = useState(true);
  const [shouldShowWarning, setShouldShowWarning] = useState(false);
  const [showSpeedModal, setShowSpeedModal] = useState(false);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const [showCurrentSpeed, setShowCurrentSpeed] = useState(true);
  const [showSpeedLimit, setShowSpeedLimit] = useState(true);
  const speedLimitRef = useRef(speedLimit);
  const prevLimitRef = useRef(null);
  const [displayTotalPoints, setDisplayTotalPoints] = useState(false);
  const [displayedPoints, setDisplayedPoints] = useState(0);
  const [startingPoints, setStartingPoints] = useState(route.params?.totalPoints ?? 0);
  const [distractedNotificationsEnabled, setDistractedNotificationsEnabled] = useState(true);
  const [distractedCount, setDistractedCount] = useState(0);
  const [distractedUI, setDistractedUI] = useState(false);
  const [showEmergencyModal, setShowEmergencyModal] = useState(false);
  const [trustedContacts, setTrustedContacts] = useState([]);
  const hasStartedDriving = useRef(false);
  const [audioSpeedUpdatesEnabled, setAudioSpeedUpdatesEnabled] = useState(true);
  const [isEmergencyActive, setIsEmergencyActive] = useState(false);
  const user = auth.currentUser;
  const speedRef = useRef(0);
  const speedingTimeoutRef = useRef(null);
  const appState = useRef(AppState.currentState);
  const locationSubscription = useRef(null);
  const pointTimer = useRef(null);
  const isAppActive = useRef(true);
  const isDistracted = useRef(false);
  const opacity = useRef(new Animated.Value(0)).current;
  const warningOpacity = useRef(new Animated.Value(0)).current;
  const backgroundTimeout = useRef(null);
  const driveFinalizedRef = useRef(false);
  const lastLocation = useRef(null);
  const totalDistance = useRef(0); 
  const [weather, setWeather] = useState(null);
  const lastWeatherFetchTime = useRef(0);
  const lastWeatherCoords = useRef(null);
  const DEFAULT_SPEED_LIMIT_MPH = 25;
  const DEFAULT_SPEED_LIMIT_KPH = DEFAULT_SPEED_LIMIT_MPH * 1.60934;
  const DEFAULT_DELAY = 2500;
  const speedThreshold = unit === 'kph' ? 16.0934 : 10;
  const { setDriveJustCompleted } = useDrive();
  const { resolvedTheme } = useContext(ThemeContext);
  const isDarkMode = resolvedTheme === 'dark';
  const t = useTheme();
  const modalBackgroundColor = t.colors.surface;
  const titleTextColor = t.colors.text;
  const contentTextColor = t.colors.text;
  const buttonBackgroundColor = t.colors.accent;
  const buttonTextColor = t.colors.accentText;
  const backgroundColor = t.colors.bg;
  const titleColor = t.colors.text;
  const textColor = t.colors.text;
  const moduleBackground = isDarkMode
    ? (t.colors.surfaceRaised || t.colors.surface)
    : t.colors.bgElevated;
  const altTextColor = t.colors.textMuted;
  const textOutline = 'transparent';
  const buttonColor = t.colors.accent;
  const gradientTop = t.colors.gradientTop;
  const gradientBottom = t.colors.gradientBottom;
  const [streak, setStreak] = useState(0);
  const soundRef = useRef(null);
  const driveStartTime = useRef(Date.now());
  const totalSpeedSum = useRef(0);
  const speedSampleCount = useRef(0);
  const speedingMarginSum = useRef(0);
  const speedingSampleCount = useRef(0);
  const speedingEvents = useRef(0);
  const wasSpeeding = useRef(false);
  const suddenStops = useRef(0);
  const suddenAccelerations = useRef(0);
  const phoneUsageTime = useRef(0);
  const phoneUsageStart = useRef(null);
  const lastSpeedValue = useRef(0);
  const ACCEL_THRESHOLD = 3.0; 
  const BRAKE_THRESHOLD = -3.0; 
  let lastUpdateTime = Date.now();
  const [roadSummary, setRoadSummary] = useState(null);
  const lastWeatherRef = useRef(null);
  const lastSpeedMSRef = useRef(null);

  const currentSegRef = useRef([]);  
  const segHeadingRef = useRef(null); 
  const prevFetchedLimitRef = useRef(null); 
  const prevFetchedStreetRef = useRef(null);

  const HEADING_TOL_DEG = 20; 
  const MAX_SEG_LEN_M   = 4000;
  const MIN_SEG_TO_FILL_M = 120; 


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

  const fillFinalSegmentIfAny = async () => {
    try {
      const seg = currentSegRef.current;
      const prevKph = prevFetchedLimitRef.current;
      const prevStreet = prevFetchedStreetRef.current;
      if (seg.length >= 2 && prevKph != null) {
        const a = seg[0], b = seg[seg.length - 1];
        if (haversineM(a, b) >= MIN_SEG_TO_FILL_M) {
          await fillCachePolyline(seg, prevKph, prevStreet);
        }
      }
    } catch (e) {
      console.warn('Final segment fill failed:', e);
    }
  };

  //finalize drive function
  const finalizeDrive = async () => {

    if (driveFinalizedRef.current) return;
    driveFinalizedRef.current = true;

    if (!user) return;

    stopDriving(user.uid);

    const driveDurationMs = Date.now() - driveStartTime.current;
    const droveLongEnough = driveDurationMs >= 60 * 1000;

    const wasDistracted = isDistracted.current;
    const timestamp = new Date().toISOString();

    const driveMetrics = {
      timestamp, 
      points: pointsThisDrive,
      duration: Math.round(driveDurationMs / 1000),
      distracted: distractedCount,
      avgSpeed: speedSampleCount.current
        ? totalSpeedSum.current / speedSampleCount.current
        : 0,
      avgSpeedingMargin: speedingSampleCount.current
        ? speedingMarginSum.current / speedingSampleCount.current
        : 0,
      suddenStops: suddenStops.current,
      suddenAccelerations: suddenAccelerations.current,
      phoneUsageTime: phoneUsageTime.current,
      totalDistance: totalDistance.current ?? 0,
      speedingEvents: speedingEvents.current,
    };

    if (pointsThisDrive > 0 /* && droveLongEnough */) {
      try {
        await fillFinalSegmentIfAny();
        await saveDriveMetrics(user.uid, driveMetrics);
      } catch (e) {
        console.warn('Failed to save drive history:', e);
      }
    }
      

    try {
      const userDocRef = doc(db, 'users', user.uid);
      const userDocSnap = await getDoc(userDocRef);

      const currentStreak = userDocSnap.exists() && userDocSnap.data().drivingStreak
        ? userDocSnap.data().drivingStreak
        : 0;
      if (pointsThisDrive > 0 /* && droveLongEnough */) {
        let newStreak;
        if (wasDistracted) {
          newStreak = 0; 
        } else {
          newStreak = currentStreak + 1;
        }

        await setDoc(userDocRef, { drivingStreak: newStreak }, { merge: true });
        setStreak(newStreak);
        await AsyncStorage.setItem('@streakThisDrive', '1');
      }
    } catch (e) {
      console.warn('Failed to update drive streak:', e);
    }
    
    if (pointsThisDrive > 0) {
      await AsyncStorage.setItem('@driveCompleteSnackbar', 'true');
    }
    
    await AsyncStorage.setItem('@pointsThisDrive', pointsThisDrive.toString());
    await AsyncStorage.setItem('@driveWasDistracted', isDistracted.current ? 'true' : 'false');
    
    setDriveJustCompleted(true);
  };
       
  useFocusEffect(
    React.useCallback(() => {
      const fetchStreak = async () => {
        const uid = auth.currentUser?.uid;
        if (!uid) return;

        try {
          const userDocRef = doc(db, "users", uid);
          const userSnap = await getDoc(userDocRef);
          if (userSnap.exists() && userSnap.data().drivingStreak) {
            setStreak(userSnap.data().drivingStreak);
          }
        } catch (err) {
          console.warn("⚠️ Failed to fetch streak:", err);
        }
      };

      fetchStreak();
    }, [])
  );

  useEffect(() => {
    if (!hasStartedDriving.current && speedRef.current >= speedThreshold) {
      hasStartedDriving.current = true;
      startDriving(user.uid);
    }
  }, [speedRef.current, user.uid]);

  //make calls within app 
  const callNumber = (phone) => {
    if (!phone) {
      Alert.alert('Error', 'No phone number provided.');
      return;
    }

    const phoneNumber = `tel:${phone}`;
    Linking.canOpenURL(phoneNumber)
      .then((supported) => {
        if (!supported) {
          Alert.alert('Error', 'Phone call is not supported on this device.');
        } else {
          return Linking.openURL(phoneNumber);
        }
      })
      .catch((err) => console.error('Failed to call number:', err));
  };

  //load contacts
  useFocusEffect(
    React.useCallback(() => {
      const uid = auth.currentUser?.uid;

      const loadContacts = async () => {
        const contacts = await getTrustedContacts(uid);
        setTrustedContacts(contacts);
      };

      loadContacts();

    }, [])
  );

  //request notification permissions
  useEffect(() => {
    const requestPermissions = async () => {
      if (Device.isDevice) {
        const { status } = await Notifications.requestPermissionsAsync();
        if (status !== 'granted') {
          console.warn('Notification permissions not granted');
        }
      }
    };
    requestPermissions();
  }, []);

  //load relevant settings on focus
  useFocusEffect(
    React.useCallback(() => {
      (async () => {
        try {
          const storedUnit = await AsyncStorage.getItem('@speedUnit');
          const storedWarnings = await AsyncStorage.getItem('@speedingWarningsEnabled');
          const storedShowCurrentSpeed = await AsyncStorage.getItem('@showCurrentSpeed');
          const storedShowSpeedLimit = await AsyncStorage.getItem('@showSpeedLimit');
          const storedDisplayMode = await AsyncStorage.getItem('@displayTotalPoints');
          const storedDistracted = await AsyncStorage.getItem('@distractedNotificationsEnabled');
          const storedAudioSpeedUpdates = await AsyncStorage.getItem('@audioSpeedUpdatesEnabled');

          if (storedUnit === 'mph' || storedUnit === 'kph') setUnit(storedUnit);
          if (storedWarnings !== null) setShowSpeedingWarning(storedWarnings === 'true');
          if (storedShowCurrentSpeed !== null) setShowCurrentSpeed(storedShowCurrentSpeed === 'true');
          if (storedShowSpeedLimit !== null) setShowSpeedLimit(storedShowSpeedLimit === 'true');
          if (storedDisplayMode !== null) setDisplayTotalPoints(storedDisplayMode === 'true');
          if (storedDistracted !== null) setDistractedNotificationsEnabled(storedDistracted === 'true');
          if (storedAudioSpeedUpdates !== null) setAudioSpeedUpdatesEnabled(storedAudioSpeedUpdates === 'true');
        } catch (err) {
          console.warn('⚠️ Failed to load settings:', err);
        }
      })();
    }, [])
  );

  //update displayed points based on settings
  useEffect(() => {
    if (displayTotalPoints) {
      setDisplayedPoints(startingPoints + pointsThisDrive);
    } else {
      setDisplayedPoints(pointsThisDrive);
    }
  }, [pointsThisDrive, displayTotalPoints, startingPoints]);

  //reset points and isDistracted on mount
  useEffect(() => {
    setDistractedUI(false);
    setStartingPoints(route.params?.totalPoints ?? 0);
    setPointsThisDrive(0);
    isDistracted.current = false;
    driveStartTime.current = Date.now();
  }, []);
  
  //update speed 
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  //handle app state changes for backgrounding
  const firstNotificationId = useRef(null);
  const unfocusedAt = useRef(null);

  useEffect(() => {
    const handleAppStateChange = async (nextAppState) => {
      const wasActive = appState.current === 'active';
      const nowInactive = nextAppState !== 'active';

      appState.current = nextAppState;
      isAppActive.current = !nowInactive;

      if (wasActive && nowInactive) {
        unfocusedAt.current = Date.now();
        if (pointsThisDrive > 0) {
          setDistractedCount(prev => prev + 1);
        }
        backgroundTimeout.current = setTimeout(async () => {
          
          if (pointsThisDrive > 0) {
            isDistracted.current = true;
            setDistractedUI(true);
            
            await Notifications.scheduleNotificationAsync({
              content: {
                title: 'Drive ended',
                body: 'Drive has ended after 2 minutes of inactivity. Your streak has been reset.',
              },
              trigger: null,
            });

          }
          
          await finalizeDrive();
          if (isEmergencyActive) {
            cancelGroupEmergency();
          }
          navigation.goBack();
        }, 2 * 60 * 1000);

        if (distractedNotificationsEnabled && pointsThisDrive > 0) {
          firstNotificationId.current = await scheduleFirstDistractedNotification();
        }
      }

      if (!nowInactive && unfocusedAt.current) {
        const unfocusedDuration = Date.now() - unfocusedAt.current;

        if (backgroundTimeout.current) {
          clearTimeout(backgroundTimeout.current);
          backgroundTimeout.current = null;
        }

        if (pointsThisDrive > 0) {
          
          
          if (unfocusedDuration > 5000) {
            isDistracted.current = true;
            stopPointEarning();
            setDistractedUI(true);

            if (firstNotificationId.current) {
              await Notifications.cancelScheduledNotificationAsync(firstNotificationId.current);
              firstNotificationId.current = null;
            }

            if (distractedNotificationsEnabled) {
              await scheduleDistractedNotification();
            }
          } else {
            if (firstNotificationId.current) {
              await Notifications.cancelScheduledNotificationAsync(firstNotificationId.current);
              firstNotificationId.current = null;
            }
          }
        }

        unfocusedAt.current = null;
      }
    };

    const subscription = AppState.addEventListener('change', handleAppStateChange);

    return () => {
      subscription.remove();
      if (backgroundTimeout.current) {
        clearTimeout(backgroundTimeout.current);
        backgroundTimeout.current = null;
      }
    };
  }, [pointsThisDrive, distractedNotificationsEnabled, navigation]);

  useEffect(() => {
    speedLimitRef.current = speedLimit;
  }, [speedLimit]);

  //location and speed tracking + speed limit logic
  useEffect(() => {

    (async () => {
      await loadSpeedLimitCache();

      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert('Permission denied', 'Location permission is required.');
        return;
      }

      locationSubscription.current = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.High,
          timeInterval: 1000,
          distanceInterval: 10,
        },
        async (loc) => {
          if (!isAppActive.current) return;

          const coordinates = [loc.coords.latitude, loc.coords.longitude];
          const testcoordinates = [47.47507848523105, -115.8893871887757];
          const rawSpeed = loc.coords.speed ?? 0;
          const lat = coordinates[0];
          const lon = coordinates[1];

          const currPt = { latitude: lat, longitude: lon };

          const seg = currentSegRef.current;
          if (seg.length === 0) {
            seg.push(currPt);
            segHeadingRef.current = null;
          } else {
            const lastPt = seg[seg.length - 1];
            const d = haversineM(lastPt, currPt);
            if (d >= 5) { 
              const brg = bearingDeg(lastPt, currPt);
              if (segHeadingRef.current == null) {
                segHeadingRef.current = brg;
              }
              const diff = Math.abs(segHeadingRef.current - brg);
              const headingDelta = Math.min(diff, 360 - diff);

              const segStart = seg[0];
              const segLen   = haversineM(segStart, currPt);

              if (headingDelta > HEADING_TOL_DEG || segLen > MAX_SEG_LEN_M) {
                currentSegRef.current = [lastPt, currPt];
                segHeadingRef.current = brg;
              } else {
                seg.push(currPt);
                segHeadingRef.current = segHeadingRef.current * 0.9 + brg * 0.1;
              }
            }
          }


          if (lastLocation.current) {
            const dist = getDistanceFromLatLonInMeters(
              lastLocation.current.latitude,
              lastLocation.current.longitude,
              lat,
              lon
            );
            totalDistance.current += dist;
          }
          lastLocation.current = { latitude: lat, longitude: lon };

          const gridKey = getGridKey(lat, lon);
          if (speedLimitCache.has(gridKey)) {
            const cached = speedLimitCache.get(gridKey);
            const adjusted = unit === 'mph' ? cached.valueKph * 0.621371 : cached.valueKph;
            setSpeedLimit(adjusted);

            if (prevFetchedLimitRef.current == null) {
              prevFetchedLimitRef.current  = cached.valueKph;
              prevFetchedStreetRef.current = cached.street ?? undefined;
            }
          } else {
            const now = Date.now();
            const distSinceLastFetch = lastSpeedLimitFetchCoords
              ? getDistanceFromLatLonInMeters(
                  lastSpeedLimitFetchCoords.latitude,
                  lastSpeedLimitFetchCoords.longitude,
                  lat,
                  lon
                )
              : Infinity; 

            if (showSpeedLimit && now - lastSpeedLimitFetchTime > 15000 && distSinceLastFetch >= 250) {
              lastSpeedLimitFetchTime = now;
              lastSpeedLimitFetchCoords = { latitude: lat, longitude: lon };

              const result = await fetchSpeedLimit(lat, lon);
              if (result && result.valueKph != null) {
                const { valueKph, street } = result;

                const prevKph   = prevFetchedLimitRef.current;
                const prevStreet= prevFetchedStreetRef.current;
                const changedLimit = prevKph != null && Math.abs(prevKph - valueKph) >= 0.5;
                const changedStreet = prevStreet && street && prevStreet !== street;

                if ((changedLimit || changedStreet) && currentSegRef.current.length >= 2) {
                  const a = currentSegRef.current[0];
                  const b = currentSegRef.current[currentSegRef.current.length - 1];
                  if (haversineM(a, b) >= MIN_SEG_TO_FILL_M) {
                    await fillCachePolyline(currentSegRef.current, prevKph, prevStreet);
                  }
                  currentSegRef.current = [ { latitude: lat, longitude: lon } ];
                  segHeadingRef.current = null;
                }

                const gridKeyNow = getGridKey(lat, lon);
                speedLimitCache.set(gridKeyNow, { valueKph, timestamp: Date.now(), street });
                await saveSpeedLimitCache();

                const uiValue = unit === 'mph' ? valueKph * 0.621371 : valueKph;
                setSpeedLimit(uiValue);

                prevFetchedLimitRef.current  = valueKph;
                prevFetchedStreetRef.current = street;
              }
            }
          }

          const calcSpeed = unit === 'kph' ? rawSpeed * 3.6 : rawSpeed * 2.23694;

          const safeSpeed = Math.max(0, calcSpeed);
          setSpeed(safeSpeed);
          speedRef.current = safeSpeed;

          totalSpeedSum.current += safeSpeed;
          speedSampleCount.current++;

          const limit = Number(speedLimitRef.current ?? (unit === 'kph' ? DEFAULT_SPEED_LIMIT_KPH : DEFAULT_SPEED_LIMIT_MPH));
          if (safeSpeed > limit) {
            speedingMarginSum.current += safeSpeed - limit;
            speedingSampleCount.current++;
          }

          

          const nowAccel = Date.now();
          const dt = (nowAccel - lastUpdateTime) / 1000;
          const speedMS = rawSpeed ?? 0;
          const prevMS  = lastSpeedMSRef.current ?? speedMS;
          const accel   = dt > 0 ? (speedMS - prevMS) / dt : 0;

          if (accel > ACCEL_THRESHOLD)  suddenAccelerations.current++;  
          if (accel < BRAKE_THRESHOLD) suddenStops.current++;

          lastSpeedMSRef.current = speedMS;
          lastUpdateTime = nowAccel;

          const nowWeather = Date.now();
          const elapsed = (nowWeather - lastWeatherFetchTime.current) / 1000; 
          const distSinceLastWeather = lastWeatherCoords.current
            ? getDistanceFromLatLonInMeters(
                lastWeatherCoords.current.latitude,
                lastWeatherCoords.current.longitude,
                lat,
                lon
              )
            : Infinity;

          if (elapsed >= 10 && distSinceLastWeather >= 100) {
            try {
              const data = await fetchWeather(lat, lon);
              if (data) {
                setWeather(data);
                lastWeatherFetchTime.current = nowWeather;
                lastWeatherCoords.current = { latitude: lat, longitude: lon };
              }
            } catch (err) {
              console.error("Weather fetch error:", err);
            }
          }

          
        }
      );
    })();

    return () => {
      locationSubscription.current?.remove();
      stopPointEarning();
      fillFinalSegmentIfAny();
    };
  }, [unit]);

  //get weather summary from gpt
  useEffect(() => {

    if (!weather?.current) return;

    const currentMetrics = {
      visibility: weather.current.visibility,
      precipitation: weather.current.precipitation,
      precipitation_probability: weather.current.precipitation_probability,
      slippery: isRoadSlippery(weather),
    };

    if (hasSignificantChange(lastWeatherRef.current, currentMetrics)) {
      (async () => {
        try {
          const result = await getRoadConditionSummary(currentMetrics);
          if (result) {
            setRoadSummary(result); 
            lastWeatherRef.current = currentMetrics;
          }
        } catch (err) {
          console.error("Error fetching road summary:", err);
        }
      })();
    }
  }, [weather]);


    
  //audio update if changing speed limits

  useEffect(() => {
    if (!audioSpeedUpdatesEnabled || speedLimit == null) return;

    const rounded = Math.round(Number(speedLimit));
    if (prevLimitRef.current === rounded) return; 

    Speech.stop();
    Speech.speak(`Speed limit is ${rounded} ${unit === 'kph' ? 'kilometers per hour' : 'miles per hour'}`, {
      language: "en",
      pitch: 0.8,
      rate: 0.8,
    });

    prevLimitRef.current = rounded;
  }, [speedLimit, unit, audioSpeedUpdatesEnabled]);


  //increment points based on speed
  const scheduleNextPoint = () => {
    const currentSpeed = speedRef.current;
    const eff = Number(speedLimitRef.current ?? (unit === 'kph' ? DEFAULT_SPEED_LIMIT_KPH : DEFAULT_SPEED_LIMIT_MPH));
    let delay = currentSpeed <= eff
      ? DEFAULT_DELAY
      : DEFAULT_DELAY + Math.min((currentSpeed - eff) / eff, 2) * 2000;

    if (currentSpeed > eff * 1.5) {
      pointTimer.current = setTimeout(scheduleNextPoint, delay);
      return;
    }

    pointTimer.current = setTimeout(() => {
      const v = speedRef.current;
      const e = Number(speedLimitRef.current ?? (unit === 'kph' ? DEFAULT_SPEED_LIMIT_KPH : DEFAULT_SPEED_LIMIT_MPH));
      if (v <= e * 1.25 && v > speedThreshold) setPointsThisDrive(p => p + 1);
      scheduleNextPoint();
    }, delay);
  };



  //start and stop point earning based on app state
  const startPointEarning = () => {
    if (!pointTimer.current) scheduleNextPoint();
  };

  const stopPointEarning = () => {
    if (pointTimer.current) {
      clearTimeout(pointTimer.current);
      pointTimer.current = null;
    }
  };

  //fetch speed limit from HERE API
  const fetchSpeedLimit = async (lat, lon) => {
    try {
      const items = await fetchHereRevGeocode(lat, lon);
      const item = items?.[0];
      const street = item?.address?.street || item?.address?.label || '[Unknown Street]';
      const speedObj = item?.navigationAttributes?.speedLimits?.[0];

      if (!speedObj?.maxSpeed || !speedObj?.speedUnit) {
        return null;
      }
      const raw = speedObj.maxSpeed;
      const unitSrc = String(speedObj.speedUnit).toLowerCase();
      const valueKph = unitSrc === 'mph' ? raw * 1.60934 : raw;
      return { valueKph, street };
    } catch (err) {
      console.error('Failed to fetch speed limit via reverse geocode:', err);
      return null;
    }
  };


  //calculate current speed limit and speeding status
  const currentLimit = Number(speedLimit ?? (unit === 'kph' ? DEFAULT_SPEED_LIMIT_KPH : DEFAULT_SPEED_LIMIT_MPH));
  const isSpeeding = Math.round(speed) > currentLimit * 1.25;
  const soundLoopIntervalRef = useRef(null);

  useEffect(() => {
    (async () => {
      await setAudioModeAsync({
        playsInSilentMode: true, 
      });
    })();
  }, []);

  useEffect(() => {
    if (isSpeeding && !wasSpeeding.current) {
      speedingEvents.current += 1;
      wasSpeeding.current = true;
    }
    if (!isSpeeding) {
      wasSpeeding.current = false; 
    }
  }, [isSpeeding]);


  useEffect(() => {
    if (showSpeedingWarning && isSpeeding) {
      if (!speedingTimeoutRef.current) {
        speedingTimeoutRef.current = setTimeout(() => {
          setShouldShowWarning(true);

          player.seekTo(0);
          player.play();

          soundLoopIntervalRef.current = setInterval(() => {
            player.seekTo(0);
            player.play();
          }, 700); 
        }, 2500);
      }
    } else {
      clearTimeout(speedingTimeoutRef.current);
      speedingTimeoutRef.current = null;

      clearInterval(soundLoopIntervalRef.current);
      soundLoopIntervalRef.current = null;

      setShouldShowWarning(false);
    }
  }, [isSpeeding, showSpeedingWarning]);

  useEffect(() => {
    return () => {
      clearTimeout(speedingTimeoutRef.current);
      clearInterval(soundLoopIntervalRef.current);
    };
  }, []);

  //show speeding warning if enabled and speeding
  useEffect(() => {
    if (shouldShowWarning) {
      setShowSpeedModal(true);
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 400,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 400,
        useNativeDriver: true,
      }).start(() => {
        setShowSpeedModal(false);
      });
    }
  }, [shouldShowWarning]);

  //start point earning when unit changes
  useEffect(() => {
    stopPointEarning();
    startPointEarning();
  }, [unit]);


  const notifyGroupEmergency = async () => {
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) return;

      const userDocRef = doc(db, "users", uid);
      const userSnap = await getDoc(userDocRef);
      const groupId = userSnap.exists() ? userSnap.data().groupId : null;

      if (groupId) {
        const groupRef = doc(db, "groups", groupId);
        const groupSnap = await getDoc(groupRef);

        let userLoc = {};
        if (groupSnap.exists()) {
          const data = groupSnap.data();
          userLoc = data.memberLocations?.[uid] || {};
        }

        const loc = await Location.getCurrentPositionAsync({});
        const { latitude, longitude, speed } = loc.coords;

        if (!userLoc.emergency) {
          await updateDoc(groupRef, {
            [`memberLocations.${uid}.latitude`]: latitude ?? null,
            [`memberLocations.${uid}.longitude`]: longitude ?? null,
            [`memberLocations.${uid}.speed`]: speed ?? 0,
            [`memberLocations.${uid}.updatedAt`]: new Date(),
            [`memberLocations.${uid}.emergency`]: true,
          });
        }

        setIsEmergencyActive(true);

        Alert.alert("Group Notified", "Emergency alert has been sent to your group.");
      } else {
        Alert.alert("⚠️ Not in a group", "You must join a group to notify them.");
      }
    } catch (err) {
      console.error("Error notifying group:", err);
      Alert.alert("Error", "Failed to notify your group. Please try again.");
    }
  };

  const cancelGroupEmergency = async () => {
    try {
      const uid = auth.currentUser?.uid;
      if (!uid) return;

      const userDocRef = doc(db, "users", uid);
      const userSnap = await getDoc(userDocRef);
      const groupId = userSnap.exists() ? userSnap.data().groupId : null;

      if (groupId) {
        const groupRef = doc(db, "groups", groupId);

        await updateDoc(groupRef, {
          [`memberLocations.${uid}.emergency`]: false,
        });

        setIsEmergencyActive(false);

        Alert.alert("Emergency Cancelled", "Your group has been notified that you are safe.");
      } else {
        Alert.alert("⚠️ Not in a group", "You must join a group to cancel emergency.");
      }
    } catch (err) {
      console.error("Error cancelling emergency:", err);
      Alert.alert("Error", "Failed to cancel emergency. Please try again.");
    }
  };

  const pulseOverlayAnim = useRef(new Animated.Value(0)).current;
  const pulseLoop = useRef(null);

  useEffect(() => {
  if (isSpeeding) {
      if (!pulseLoop.current) {
        pulseLoop.current = Animated.loop(
          Animated.sequence([
            Animated.timing(pulseOverlayAnim, {
              toValue: 0.5,
              duration: 500,
              useNativeDriver: false,
            }),
            Animated.timing(pulseOverlayAnim, {
              toValue: 0,
              duration: 500,
              useNativeDriver: false,
            }),
          ])
        );
        pulseLoop.current.start();
      }
    } else {
      if (pulseLoop.current) {
        pulseLoop.current.stop();
        pulseLoop.current = null;
      }
      pulseOverlayAnim.setValue(0);
    }
  }, [isSpeeding]);

  //UI element rendering
  return (
    <>
      {showSpeedModal && (
        <Animated.View style={[styles.modalOverlay, { opacity: fadeAnim }]} pointerEvents="box-none">
          <View style={[styles.modalContent, { backgroundColor: modalBackgroundColor, borderRadius: t.radius.xl, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border }]} pointerEvents="auto">
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12 }}>
              <MaterialCommunityIcons name="speedometer" size={22} color={t.colors.danger} style={{ marginRight: 8 }} />
              <Text style={[t.typography.heading, { color: titleTextColor }]}>You are speeding</Text>
            </View>
            <Text style={[t.typography.body, { color: altTextColor, textAlign: 'center', marginBottom: 18 }]}>
              Please slow down.
            </Text>
            <TouchableOpacity
              style={[styles.modalButton, { backgroundColor: buttonBackgroundColor, borderRadius: t.radius.md, paddingHorizontal: 24 }]}
              onPress={() => {
                Animated.timing(fadeAnim, {
                  toValue: 0,
                  duration: 400,
                  useNativeDriver: true,
                }).start(() => {
                  setShowSpeedModal(false);
                });
              }}
            >
              <Text style={[t.typography.bodyStrong, { color: buttonTextColor }]}>Dismiss</Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      )}

      {showEmergencyModal && (
        <View style={styles.modalOverlay} pointerEvents="box-none">
          <View style={[styles.modalContent, { backgroundColor: modalBackgroundColor, borderRadius: t.radius.xl, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border, alignItems: 'stretch' }]} pointerEvents="auto">
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16, justifyContent: 'center' }}>
              <MaterialCommunityIcons name="alert-octagon" size={22} color={t.colors.danger} style={{ marginRight: 8 }} />
              <Text style={[t.typography.heading, { color: titleTextColor }]}>Emergency options</Text>
            </View>

            <TouchableOpacity
              style={[styles.modalOption, { backgroundColor: t.colors.danger, borderRadius: t.radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }]}
              onPress={() => {
                setShowEmergencyModal(false);
                callNumber('911');
                Alert.alert('Calling emergency services…');
              }}
            >
              <MaterialCommunityIcons name="phone-alert" size={18} color="#fff" style={{ marginRight: 8 }} />
              <Text style={[t.typography.bodyStrong, { color: '#fff' }]}>Call emergency services</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.modalOption, { backgroundColor: t.colors.accent, borderRadius: t.radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }]}
              onPress={() => {
                setShowEmergencyModal(false);
                notifyGroupEmergency();
              }}
            >
              <MaterialCommunityIcons name="account-group" size={18} color={t.colors.accentText} style={{ marginRight: 8 }} />
              <Text style={[t.typography.bodyStrong, { color: t.colors.accentText }]}>Notify group</Text>
            </TouchableOpacity>

            {trustedContacts.map((contact, index) => (
              <TouchableOpacity
                key={index}
                style={[styles.modalOption, { backgroundColor: t.colors.accentFaint, borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.accent, borderRadius: t.radius.md, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }]}
                onPress={() => callNumber(contact.phone)}
              >
                <MaterialCommunityIcons name="phone" size={18} color={t.colors.accent} style={{ marginRight: 8 }} />
                <Text style={[t.typography.bodyStrong, { color: t.colors.accent }]}>
                  Call {contact.name || 'Unnamed'}
                </Text>
              </TouchableOpacity>
            ))}

            <TouchableOpacity
              style={[styles.modalOption, { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: t.colors.border, borderRadius: t.radius.md }]}
              onPress={() => setShowEmergencyModal(false)}
            >
              <Text style={[t.typography.bodyStrong, { color: t.colors.text, textAlign: 'center' }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <LinearGradient
        colors={[gradientBottom, gradientTop]} 
        style={[styles.background, { opacity }]}
      >
        <BlurView intensity={10} tint="dark" style={StyleSheet.absoluteFill} />
        <View style={styles.darkOverlay} />

        <View style={{ 
          flexDirection: "row", 
          justifyContent: "space-between", 
          alignItems: "center",
          marginTop: height / 15,
          marginBlock: -10,
          width: "100%"
        }}>
        <TouchableOpacity
          style={[styles.emergencyButton, { backgroundColor: t.colors.danger, borderRadius: t.radius.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }]}
          onPress={() => setShowEmergencyModal(true)}
        >
          <MaterialCommunityIcons name="alert-octagon" size={18} color="#fff" style={{ marginRight: 6 }} />
          <Text style={[t.typography.bodyStrong, { color: '#fff' }]}>Emergency</Text>
        </TouchableOpacity>

        <View style={[
          styles.module,
          {
            flex: 1,
            borderLeftWidth: 4,
            borderLeftColor: getRoadBorderColor(roadSummary?.score, t),
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: t.colors.border,
            backgroundColor: moduleBackground,
            padding: 12,
            marginLeft: 14,
            borderRadius: t.radius.lg,
            minHeight: 60,
            flexDirection: 'row',
            alignItems: 'center',
          }
        ]}>
          {roadSummary ? (
            <>
              <MaterialCommunityIcons
                name={getRoadIcon(roadSummary.score).name}
                size={20}
                color={getRoadBorderColor(roadSummary.score, t)}
                style={{ marginRight: 8 }}
              />
              <Text style={[t.typography.caption, { color: textColor, flex: 1, fontWeight: '600' }]} numberOfLines={2}>
                {roadSummary.summary}
              </Text>
            </>
          ) : (
            <Text style={[t.typography.caption, { color: altTextColor, flex: 1 }]}>Loading summary…</Text>
          )}
        </View>

        </View>

        {isEmergencyActive && (
          <View style={[styles.emergencyBanner, { backgroundColor: t.colors.danger }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <MaterialCommunityIcons name="alert-octagon" size={18} color="#fff" style={{ marginRight: 8 }} />
              <Text style={[t.typography.bodyStrong, { color: '#fff' }]}>Emergency activated</Text>
            </View>
            <TouchableOpacity
              style={[styles.emergencyBannerButton, { backgroundColor: '#fff', borderRadius: t.radius.sm }]}
              onPress={cancelGroupEmergency}
            >
              <Text style={[t.typography.bodyStrong, { color: t.colors.danger }]}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        {isEmergencyActive && (
          <View style={{...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)',zIndex: 1500,}} pointerEvents="auto" />
        )}

        <View style={styles.container}>
          
          <View style={[styles.topRow]}>
            <View style={[styles.cardWrap, { marginRight: 7.5, borderColor: t.colors.border, backgroundColor: moduleBackground, borderRadius: t.radius.xl }]}>
              <View style={[styles.module]}>
                <Text style={[styles.moduleLabel, { color: altTextColor, marginBottom: -8 }]}>Speed</Text>
                <AutoFitText
                  style={[
                    styles.moduleValue,
                    { color: interpolateColor(speed, currentLimit, t.colors), marginBottom: -8 },
                  ]}
                >
                  {Math.round(speed)}
                </AutoFitText>
                <Text
                  style={[
                    styles.moduleLabel,
                    { color: altTextColor, fontSize: 20 },
                  ]}
                >
                  {unit.toUpperCase()}
                </Text>
              </View>
            </View>

            <View style={[styles.cardWrap, { marginLeft: 7.5, borderColor: t.colors.border, backgroundColor: moduleBackground, borderRadius: t.radius.xl }]}>
              <View style={[styles.module]}>
                <Animated.View
                  pointerEvents="none"
                  style={{
                    ...StyleSheet.absoluteFillObject,
                    backgroundColor: t.colors.danger,
                    borderRadius: t.radius.xl,
                    opacity: pulseOverlayAnim,
                  }}
                />
                <Text style={[styles.moduleLabel, { color: altTextColor, marginBottom: -8 }]}>Limit</Text>

                <AutoFitText
                  style={[
                    styles.moduleValue,
                    { color: textColor, marginBottom: -8 },
                  ]}
                >
                  {Math.round(currentLimit)}
                </AutoFitText>
                <Text
                  style={[
                    styles.moduleLabel,
                    { color: altTextColor, fontSize: 20 },
                  ]}
                >
                  {unit.toUpperCase()}
                </Text>
              </View>
            </View>
          </View>

          <View style={[styles.cardWrapWide, { borderColor: t.colors.border, backgroundColor: moduleBackground, borderRadius: t.radius.xl }]}>
          <View style={[styles.moduleWideRow]}>
            <View style={styles.subModule}>
              <Text style={[styles.moduleLabel, { color: altTextColor, fontSize: 18 }]}>Points</Text>
              <AutoFitText
                style={[
                  styles.moduleValue,
                  {
                    color: distractedUI ? t.colors.danger : t.colors.accent,
                    fontSize: 45,
                  },
                ]}
              >
                {displayedPoints}
              </AutoFitText>
            </View>

            <View style={styles.subModule}>
              <Text style={[styles.moduleLabel, { color: altTextColor, fontSize: 18 }]}>
                Distractions
              </Text>
              <AutoFitText
                style={[
                  styles.moduleValue,
                  { color: distractedCount > 0 ? t.colors.warning : textColor, fontSize: 45 },
                ]}
              >
                {distractedCount}
              </AutoFitText>
            </View>
            <View style={styles.subModule}>
              <Text style={[styles.moduleLabel, { color: altTextColor, fontSize: 18 }]}>Streak</Text>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", marginTop: 2*(Math.abs(streak).toString().length - 1) }}>
                {(() => {
                  const active = distractedUI ? 0 : (streak ?? 0);
                  const flameColor = active <= 0
                    ? t.colors.textSubtle || t.colors.textMuted
                    : active < 3 ? t.colors.accentMuted
                    : active < 7 ? t.colors.accent
                    : active < 15 ? t.colors.warning
                    : t.colors.danger;
                  return (
                    <MaterialCommunityIcons
                      name="fire"
                      size={34}
                      color={flameColor}
                      style={{ marginRight: 4, marginTop: 4 }}
                    />
                  );
                })()}
              <AutoFitText
                style={[
                  styles.moduleValue,
                  { color: textColor, fontSize: 45 - 5*(Math.abs(streak).toString().length - 1) },
                ]}
              >
                {distractedUI ? 0 : streak ?? 0}
              </AutoFitText>
              </View>
            </View>
          </View>
          </View>

          <TouchableOpacity
            onPress={async () => {
              await finalizeDrive();
              navigation.goBack();
            }}
            style={styles.completeButtonWrapper}
          >
            <LinearGradient
              colors={[t.colors.accent, t.colors.accentMuted]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.completeButton}
            >
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <MaterialCommunityIcons
                  name="check-circle-outline"
                  size={22}
                  color="#fff"
                  style={{ marginRight: 8 }}
                />
                <Text style={styles.completeButtonText}>Complete Drive</Text>
              </View>
            </LinearGradient>
          </TouchableOpacity>

          <View style={[styles.cardWrapWide, { borderColor: t.colors.border, backgroundColor: moduleBackground, borderRadius: t.radius.xl }]}>
          <View style={[styles.moduleWideRow]}>


              {!weather ? (
                <View style={[styles.module, {height: 175, justifyContent: "center"}]}>
                <View style={styles.loadingBox}>
                  <ActivityIndicator size="small" color={t.colors.accent} style={{ marginBottom: 15 }} />
                  <Text style={[t.typography.caption, {color: altTextColor}]}>Loading weather data…</Text>
                </View>
                </View>
              ) : (
                <View style={[styles.module, {flexDirection: "row", height: 220, justifyContent: "center"}]}>
                <View style={{ alignItems: "center", marginRight: 24, marginLeft: -10 }}>
                  <View style={{
                    width: 150,
                    height: 150,
                    borderRadius: 75,
                    backgroundColor: t.colors.accentFaint,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 4,
                  }}>
                    <MaterialCommunityIcons
                      name={getWeatherInfo(weather.current.weathercode).icon}
                      size={110}
                      color={t.colors.accent}
                    />
                  </View>
                  <Text style={[t.typography.bodyStrong, {color: textColor, fontSize: 20, marginTop: 4}]}>
                    {getWeatherInfo(weather.current.weathercode).label || "Unknown"}
                  </Text>
                  <Text style={[t.typography.caption, {color: altTextColor, fontSize: 16}]}>
                    {Math.round(weather.current.temperature_2m)}°F
                  </Text>
                </View>

                <View style={{ flex: 1, alignItems: "center" }}>
                  <View style={{ alignItems: "center", marginBottom: 8 }}>
                    <Text style={[t.typography.bodyStrong, { fontSize: 22, color: getVisibilityColor(weather.current.visibility, t) }]}>
                      {Math.round(weather.current.visibility / 1609)} mi
                    </Text>
                    <Text style={[t.typography.micro, { color: altTextColor, textTransform: 'uppercase', letterSpacing: 1 }]}>
                      Visibility
                    </Text>
                  </View>

                  <View style={{ alignItems: "center", marginBottom: 8 }}>
                    <Text style={[t.typography.bodyStrong, { fontSize: 22, color: getPrecipitationColor(weather.current.precipitation, t) }]}>
                      {weather.current.precipitation.toFixed(1)} in
                    </Text>
                    <Text style={[t.typography.micro, { color: altTextColor, textTransform: 'uppercase', letterSpacing: 1 }]}>
                      Precipitation
                    </Text>
                  </View>

                  <View style={{ alignItems: "center", marginBottom: 8 }}>
                    <Text style={[t.typography.bodyStrong, { fontSize: 22, color: textColor }]}>
                      {weather.current.precipitation_probability}%
                    </Text>
                    <Text style={[t.typography.micro, { color: altTextColor, textTransform: 'uppercase', letterSpacing: 1 }]}>
                      Chance of Rain
                    </Text>
                  </View>
                  <View style={{ alignItems: "center", marginBottom: 8 }}>
                    <Text style={[
                      t.typography.bodyStrong,
                      { fontSize: 22, color: getAirQualityColor(weather.airQuality?.current?.us_aqi, t) }
                    ]}>
                      {weather.airQuality?.current?.us_aqi ?? "--"}
                    </Text>
                    <Text style={[t.typography.caption, { fontSize: 11, color: getAirQualityColor(weather.airQuality?.current?.us_aqi, t) }]}>
                      {getAirQualityLabel(weather.airQuality?.current?.us_aqi)}
                    </Text>
                    <Text style={[t.typography.micro, { color: altTextColor, textTransform: 'uppercase', letterSpacing: 1 }]}>
                      Air Quality
                    </Text>
                  </View>

                </View>

                </View>
              )}
            </View>

          </View>



          <View style={{ flex: 1 }} />

          
        </View>

      </LinearGradient>
    </>
  );
}

//styles
const styles = StyleSheet.create({
  background: { flex: 1, padding: 18 },
  darkOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0, 0, 0, 0)',
  },
  emergencyButton: {
    paddingVertical: 14,
    paddingHorizontal: 12,
    borderRadius: 16,
    zIndex: 1000,
    elevation: 6,
    width: "35%"
  },

  emergencyButtonText: {
    fontWeight: 'bold',
    fontSize: 16,
    textAlign: 'center',
  },

  modalOverlay: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 999,
  },

  modalContent: {
    width: '86%',
    borderRadius: 20,
    padding: (width / 375) * 22,
    alignItems: 'center',
    elevation: 10,
  },

  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
    textAlign: 'center',
  },

  modalOption: {
    borderRadius: 12,
    paddingVertical: 14,
    marginTop: 10,
    width: '100%',
  },

  modalText: {
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 0,
  },

  modalOptionText: {
    fontWeight: 'bold',
    fontSize: 16,
    textAlign: 'center',
  },

  gradientBorder: {
    padding: 3,
    borderRadius: 18,
    flex: 1,
    height: 175
  },

  gradientBorderWide: {
    marginTop: 15,
    padding: 3,
    borderRadius: 18,
  },

  cardWrap: {
    flex: 1,
    height: 175,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },

  cardWrapWide: {
    marginTop: 15,
    width: "100%",
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
  },
  
  topRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    width: "100%",
  },

  module: {
    flex: 1,
    padding: 15,
    borderRadius: 16,
    alignItems: "center",
    position: "relative",
    overflow: "hidden",
  },
  moduleLabel: {
    fontSize: 22,
    fontWeight: "600",
    letterSpacing: 0.3,
  },

  moduleValue: {
    fontSize: 72,
    fontWeight: "800",
    marginTop: 4,
    letterSpacing: -1,
  },

  weatherText: {
    fontSize: 16, 
    fontWeight: "500", 
    textAlign: "left",
  },

  completeButtonWrapper: {
    width: "100%",
    borderRadius: 20,
    overflow: "hidden", 
  },

  completeButton: {
    width: "100%",
    paddingVertical: 16,
    borderRadius: 20,
    marginTop: 15,
    alignItems: "center",
    alignSelf: "center",
  },

  completeButtonText: {
    fontSize: 20,
    fontWeight: "700",
    color: "#fff",
    letterSpacing: 0.3,
  },

  moduleWideRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    padding: 15,
    paddingHorizontal: 10,
    borderRadius: 16,
    width: "100%",
    alignSelf: "center",
  },

  subModule: {
    flex: 1,
    alignItems: "center",
  },

  speedLimitContainer: {
    position: 'absolute',
    top: (height / 667) * 45,
    right: (width / 375) * 10,
    width: (width / 375) * 100,
    height: (width / 375) * 100,
  },
  speedLimitSign: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  speedLimitText: {
    paddingTop: (height / 667) * 35,
    fontSize: 36,
    fontWeight: 'bold',
    color: '#000',
    textAlign: 'center',
  },
  emergencyBanner: {
    position: 'absolute',
    top: (height / 667) * 60,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 16,
    paddingHorizontal: 16,
    zIndex: 2000,
    elevation: 20,
  },
  emergencyBannerButton: {
    paddingVertical: 6,
    paddingHorizontal: 12,
  },

  container: {
    flex: 1,
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 25,
  },
  pointsContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  pointsWrapper: {
    maxWidth: '90%',
    width: '90%',
    alignItems: 'center',
  },
  points: {
    marginTop: (height / 667) * 100,
    fontWeight: 'bold',
    color: '#fff',
    textShadowColor: '#0000007a',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 6,
    textAlign: 'center',
  },
  pointsLabel: {
    fontSize: (width / 375) * 24,
    color: '#fff',
    marginTop: (height / 667) * -20,
  },
  completeDriveButtonContainer: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 999,
  },
  completeDriveButtonWrapper: {
    marginTop: (height / 667) * 0,
    marginBottom: (height / 667) * 0,
    alignItems: 'center',
    justifyContent: 'center',
  },

  speedBackground: {
    width: '100%',
    height: height * 1/3.1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: (height / 667) * -50,
    borderRadius: (width / 375) * 20,
    overflow: 'hidden',
  },
  speedText: {
    fontSize: (width / 375) * 48,
    fontWeight: '800',
    letterSpacing: -0.5,
    marginBottom: 0,
  },
  warningOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  warningOverlayText: {
    fontSize: (width / 375) * 32,
    fontWeight: 'bold',
    color: '#ff4444',
    textAlign: 'center',
    paddingHorizontal: (width / 375) * 20,
    textShadowColor: '#000',
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: (width / 375) * 6,
  },
  modalButton: {
    marginTop: 16,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 12,
    alignSelf: 'center',
  },
  loadingBox: { alignItems: 'center' },
  loadingText: { marginTop: 8, fontSize: 14 },
});
