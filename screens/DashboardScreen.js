import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Animated,
  Pressable,
  ImageBackground,
  Dimensions,
  ScrollView,
  ActivityIndicator,
  Easing,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { BlurView } from 'expo-blur';
import { Snackbar } from 'react-native-paper';
import ConfettiCannon from 'react-native-confetti-cannon';

import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../utils/firebase';
import {
  getUserPoints,
  saveUserPoints,
  getUsername,
  getTotalDrivesNumber,
} from '../utils/firestore';
import { getFirestore, doc, getDoc } from 'firebase/firestore';

import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  Button,
  AutoFitText,
  useTheme,
} from '../theme';

const firestore = getFirestore();
const { width, height } = Dimensions.get('window');

const getStorageKey = (uid) => `totalPoints_${uid}`;

const USER_DOC_TTL_MS = 30_000;
const userDocCache = { uid: null, data: null, ts: 0 };

async function getCachedUserDoc(uid) {
  const now = Date.now();
  if (
    userDocCache.uid === uid &&
    userDocCache.data &&
    now - userDocCache.ts < USER_DOC_TTL_MS
  ) {
    return userDocCache.data;
  }
  const snap = await getDoc(doc(firestore, 'users', uid));
  const data = snap.exists() ? snap.data() : null;
  userDocCache.uid = uid;
  userDocCache.data = data;
  userDocCache.ts = now;
  return data;
}

export function invalidateDashboardUserCache() {
  userDocCache.uid = null;
  userDocCache.data = null;
  userDocCache.ts = 0;
}

const fireImages = {
  gray: require('../assets/streaks/gray.png'),
  orange: require('../assets/streaks/orange.png'),
  green: require('../assets/streaks/green.png'),
  purple: require('../assets/streaks/purple.png'),
  pink: require('../assets/streaks/pink.png'),
  blue: require('../assets/streaks/blue.png'),
};

function getFireImage(streak) {
  if (streak === 0) return fireImages.gray;
  if (streak <= 10) return fireImages.orange;
  if (streak <= 25) return fireImages.green;
  if (streak <= 50) return fireImages.purple;
  if (streak <= 100) return fireImages.pink;
  return fireImages.blue;
}

function interpolateColor(percent) {
  const p = Math.min(Math.max(percent, 0), 100) / 100;
  const start = { r: 230, g: 80, b: 80 };
  const mid = { r: 240, g: 180, b: 60 };
  const end = { r: 0, g: 179, b: 134 };
  let r, g, b;
  if (p < 0.5) {
    const k = p / 0.5;
    r = Math.round(start.r + (mid.r - start.r) * k);
    g = Math.round(start.g + (mid.g - start.g) * k);
    b = Math.round(start.b + (mid.b - start.b) * k);
  } else {
    const k = (p - 0.5) / 0.5;
    r = Math.round(mid.r + (end.r - mid.r) * k);
    g = Math.round(mid.g + (end.g - mid.g) * k);
    b = Math.round(mid.b + (end.b - mid.b) * k);
  }
  return `rgb(${r},${g},${b})`;
}

export default function DashboardScreen({ route }) {
  const navigation = useNavigation();
  const t = useTheme();

  const [user, setUser] = useState(null);
  const [totalPoints, setTotalPoints] = useState(null);
  const [username, setUsername] = useState('Guest');
  const [totalDrives, setTotalDrives] = useState(null);
  const [streak, setStreak] = useState(0);
  const [safetyScore, setSafetyScore] = useState(null);
  const [loading, setLoading] = useState(true);

  const animatedPoints = useRef(new Animated.Value(0)).current;
  const [displayedPoints, setDisplayedPoints] = useState(0);
  const animatedDrives = useRef(new Animated.Value(0)).current;
  const [displayedDrives, setDisplayedDrives] = useState(0);

  const [snackbarVisible, setSnackbarVisible] = useState(false);
  const [snackbarColor, setSnackBarColor] = useState();
  const [snackbarMessage, setSnackbarMessage] = useState('');
  const confettiRef = useRef(null);
  const [confettiVisible, setConfettiVisible] = useState(false);

  useEffect(() => {
    if (user?.uid) {
      getUsername(user.uid).then((name) => setUsername(name));
      getTotalDrivesNumber(user.uid).then((n) => setTotalDrives(Number(n) || 0));
    } else {
      setTotalDrives(null);
    }
  }, [user]);

  useEffect(() => {
    const listener = animatedPoints.addListener(({ value }) => {
      setDisplayedPoints(Math.floor(value));
    });
    return () => animatedPoints.removeListener(listener);
  }, [animatedPoints]);

  useEffect(() => {
    const sub = animatedDrives.addListener(({ value }) => {
      setDisplayedDrives(Math.floor(value));
    });
    return () => animatedDrives.removeListener(sub);
  }, [animatedDrives]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      const run = async () => {
        if (!user?.uid) return;
        const raw = await getTotalDrivesNumber(user.uid);
        const to = Number.isFinite(raw) ? raw : parseInt(raw, 10);
        const drives = Number.isFinite(to) ? to : 0;
        if (!active) return;
        setTotalDrives(drives);
        animatedDrives.stopAnimation();
        animatedDrives.setValue(0);
        Animated.timing(animatedDrives, {
          toValue: drives,
          duration: 350,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }).start();
      };
      run();
      return () => {
        active = false;
        animatedDrives.stopAnimation();
      };
    }, [user?.uid])
  );

  const animatePoints = useCallback(
    (from, to) => {
      animatedPoints.stopAnimation();
      animatedPoints.setValue(from ?? 0);
      Animated.timing(animatedPoints, {
        toValue: to ?? 0,
        duration: 350,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: false,
      }).start();
    },
    [animatedPoints]
  );

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setTotalPoints(null);
      animatedPoints.setValue(0);
      setDisplayedPoints(0);
      animatedDrives.setValue(0);
      setDisplayedDrives(0);

      if (firebaseUser) {
        setUser(firebaseUser);
        const uid = firebaseUser.uid;
        try {
          const firestorePoints = await getUserPoints(uid);
          if (firestorePoints == null || isNaN(firestorePoints)) {
            setTotalPoints(0);
            await AsyncStorage.removeItem(getStorageKey(uid));
          } else {
            await AsyncStorage.setItem(getStorageKey(uid), firestorePoints.toString());
            setTotalPoints(firestorePoints);
            animatePoints(0, firestorePoints);
          }
        } catch (e) {
          console.error('Error fetching data on auth change:', e);
          setTotalPoints(0);
        }
      } else {
        setUser(null);
        setTotalPoints(0);
      }
    });
    return unsubscribe;
  }, [animatedPoints, animatePoints, animatedDrives]);

  useFocusEffect(
    useCallback(() => {
      setLoading(false);
    }, [user])
  );

  useFocusEffect(
    useCallback(() => {
      let isActive = true;
      const loadPoints = async () => {
        if (!user) {
          if (isActive) {
            setTotalPoints(0);
          }
          return;
        }
        try {
          const key = getStorageKey(user.uid);
          const [storedStr, driveStr] = await Promise.all([
            AsyncStorage.getItem(key),
            AsyncStorage.getItem('@pointsThisDrive'),
          ]);
          let total = storedStr ? parseInt(storedStr, 10) : 0;
          const drivePoints = driveStr ? parseInt(driveStr, 10) : 0;
          if (drivePoints > 0) {
            total += drivePoints;
            await AsyncStorage.setItem(key, total.toString());
            await AsyncStorage.removeItem('@pointsThisDrive');
            await saveUserPoints(user.uid, total);
          } else {
            const data = await getCachedUserDoc(user.uid);
            if (data && data.points != null) {
              const remote = data.points;
              if (remote > total) {
                total = remote;
                await AsyncStorage.setItem(key, total.toString());
              }
            }
          }
          if (isActive) {
            setTotalPoints(total);
            animatePoints(0, total);
          }
        } catch (e) {
          console.error('Error loading points on focus:', e);
          if (isActive) setTotalPoints(0);
        }
      };
      loadPoints();
      return () => {
        isActive = false;
      };
    }, [user, animatePoints])
  );

  useFocusEffect(
    useCallback(() => {
      const loadStreak = async () => {
        if (user) {
          const data = await getCachedUserDoc(user.uid);
          setStreak(data?.drivingStreak || 0);
        } else {
          setStreak(0);
        }
      };
      loadStreak();
    }, [user])
  );

  useFocusEffect(
    useCallback(() => {
      let isActive = true;
      (async () => {
        try {
          const [driveCompleteFlag, wasDistractedFlag] = await Promise.all([
            AsyncStorage.getItem('@driveCompleteSnackbar'),
            AsyncStorage.getItem('@driveWasDistracted'),
          ]);
          if (driveCompleteFlag === 'true' && isActive) {
            if (wasDistractedFlag === 'true') {
              setSnackbarMessage('Streak reset. You were distracted!');
              setSnackBarColor(t.colors.danger);
            } else {
              setSnackbarMessage('Drive complete. You were focused!');
              setSnackBarColor(t.colors.accent);
            }
            setConfettiVisible(false);
            setTimeout(() => {
              if (!isActive) return;
              setConfettiVisible(true);
            }, 50);
          }
          await AsyncStorage.multiRemove(['@driveCompleteSnackbar', '@driveWasDistracted']);
        } catch (e) {
          console.warn('Error checking drive complete or distraction flags', e);
        }
      })();
      return () => {
        isActive = false;
      };
    }, [t.colors.danger, t.colors.accent])
  );

  useEffect(() => {
    if (confettiVisible && confettiRef.current) confettiRef.current.start();
  }, [confettiVisible]);

  useEffect(() => {
    if (route.params?.showDriveCompleteSnackbar) {
      setSnackbarVisible(true);
      navigation.setParams({ showDriveCompleteSnackbar: false });
    }
  }, [route.params, navigation]);

  useFocusEffect(
    useCallback(() => {
      let isActive = true;
      const loadSafetyScore = async () => {
        try {
          const stored = await AsyncStorage.getItem('safetyScore');
          if (stored !== null && isActive) setSafetyScore(parseInt(stored, 10));
        } catch (err) {
          console.error('Error loading safety score:', err);
        }
      };
      loadSafetyScore();
      return () => {
        isActive = false;
      };
    }, [])
  );

  const renderHeatBar = (score) => {
    const markerSize = 26;
    const barWidth = width - 80;
    const margin = 14;
    const usableWidth = barWidth - 2 * margin;
    const clamped = Math.min(Math.max(score, 0), 100);
    const markerLeft = margin + (usableWidth * clamped) / 100 - markerSize / 2;
    const scoreColor = interpolateColor(clamped);

    return (
      <View style={{ height: 52, justifyContent: 'center' }}>
        <View
          style={{
            height: 10,
            borderRadius: 5,
            backgroundColor: t.colors.divider,
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              height: 10,
              width: `${clamped}%`,
              backgroundColor: scoreColor,
            }}
          />
        </View>
        <View
          style={{
            position: 'absolute',
            left: markerLeft,
            width: markerSize,
            height: markerSize,
            borderRadius: markerSize / 2,
            backgroundColor: t.colors.surface,
            borderWidth: 3,
            borderColor: scoreColor,
            top: (52 - markerSize) / 2,
          }}
        />
      </View>
    );
  };

  return (
    <Screen>
      <View style={{ flex: 1 }}>
        {loading && (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              justifyContent: 'center',
              alignItems: 'center',
              zIndex: 10,
            }}
          >
            <ActivityIndicator size="small" color={t.colors.accent} />
          </View>
        )}
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ paddingBottom: 32 }}
        >
          <ScreenHeader
            eyebrow={`Hi, ${user ? username : 'guest'}`}
            title="Dashboard"
            subtitle={new Date().toDateString()}
            right={
              user ? (
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: t.colors.surface,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: t.colors.border,
                    paddingHorizontal: 10,
                    borderRadius: 999,
                  }}
                >
                  <Image
                    source={getFireImage(streak)}
                    style={{ width: 20, height: 20, marginRight: 3 }}
                  />
                  {/* Changed to AutoFitText and added paddingRight: 4 to fix the clipping */}
                  <AutoFitText 
                    style={[
                      t.typography.numeric, 
                      { color: t.colors.text, fontSize: 20, paddingRight: 3 }
                    ]}
                  >
                    {streak}
                  </AutoFitText>
                </View>
              ) : (
                <Pressable
                  onPress={() => navigation.navigate('Login')}
                  style={{
                    paddingVertical: 8,
                    paddingHorizontal: 14,
                    borderRadius: 999,
                    backgroundColor: t.colors.accent,
                  }}
                >
                  <Text style={{ color: t.colors.accentText, fontWeight: '700' }}>Log in</Text>
                </Pressable>
              )
            }
          />

          <Section>
            <Pressable
              onPress={() => navigation.navigate('Drive', { totalPoints })}
              style={({ pressed }) => ({
                borderRadius: t.radius.lg,
                overflow: 'hidden',
                height: 120,
                opacity: pressed ? 0.92 : 1,
              })}
            >
              <ImageBackground
                source={require('../assets/drivebutton.jpeg')}
                style={{ flex: 1, justifyContent: 'flex-end' }}
                imageStyle={{ borderRadius: t.radius.lg }}
                resizeMode="cover"
              >
                <View
                  style={{
                    ...StyleSheet.absoluteFillObject,
                    backgroundColor: 'rgba(4,8,10,0.55)',
                  }}
                />
                <View
                  style={{
                    padding: 20,
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                >
                  <View>
                    <Text
                      style={{
                        color: 'rgba(255,255,255,0.7)',
                        fontSize: 11,
                        fontWeight: '700',
                        letterSpacing: 1.4,
                        textTransform: 'uppercase',
                        marginBottom: 4,
                      }}
                    >
                      Ready when you are
                    </Text>
                    <Text
                      style={{
                        color: '#fff',
                        fontSize: 26,
                        fontWeight: '800',
                        letterSpacing: -0.4,
                      }}
                    >
                      Start driving
                    </Text>
                  </View>
                  <View
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 22,
                      backgroundColor: t.colors.accent,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Ionicons name="arrow-forward" size={22} color={t.colors.accentText} />
                  </View>
                </View>
              </ImageBackground>
            </Pressable>
          </Section>

          <Section label="My stats">
            <Card>
              <View style={{ flexDirection: 'row' }}>
                <StatCell
                  t={t}
                  label="Points"
                  value={totalPoints !== null ? displayedPoints.toLocaleString() : '—'}
                  accent
                />
                <DividerCell t={t} />
                <StatCell
                  t={t}
                  label="Drives"
                  value={totalDrives == null ? '—' : String(displayedDrives)}
                />
                <DividerCell t={t} />
                <StatCell
                  t={t}
                  label="Streak"
                  value={String(streak)}
                />
              </View>
            </Card>
          </Section>

          <Section label="Driver score">
            <Card>
              {safetyScore !== null ? (
                <>
                  <View
                    style={{
                      flexDirection: 'row',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 10,
                    }}
                  >
                    <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>
                      Safety rating
                    </Text>
                    <AutoFitText
                      style={[
                        t.typography.numeric,
                        { color: interpolateColor(safetyScore), fontSize: 26 },
                      ]}
                    >
                      {safetyScore}
                    </AutoFitText>
                  </View>
                  {renderHeatBar(safetyScore)}
                </>
              ) : (
                <View style={{ alignItems: 'center', paddingVertical: 6 }}>
                  <Text
                    style={[
                      t.typography.caption,
                      { color: t.colors.textMuted, marginBottom: 12, textAlign: 'center' },
                    ]}
                  >
                    No score yet. Generate one from your drive data.
                  </Text>
                  <Button
                    title="Get safety score"
                    variant="soft"
                    icon={<Ionicons name="sparkles" size={16} color={t.colors.accent} />}
                    onPress={() => navigation.navigate('AIScreen')}
                  />
                </View>
              )}
            </Card>
          </Section>

          <Section label="Insights">
            <Button
              title="View full driver report"
              icon={<Ionicons name="sparkles" size={18} color={t.colors.accentText} />}
              onPress={() => navigation.navigate('AIScreen')}
            />
          </Section>

          <Section label="Family safety">
            <Button
              title="My group"
              variant="ghost"
              icon={<Ionicons name="people-outline" size={18} color={t.colors.text} />}
              onPress={() => navigation.navigate('LocationScreen')}
            />
          </Section>

          <Snackbar
            visible={snackbarVisible}
            onDismiss={() => setSnackbarVisible(false)}
            duration={3000}
            style={{
              backgroundColor: t.colors.surfaceRaised,
              marginBottom: height / 5,
              borderRadius: t.radius.md,
              borderWidth: 1,
              borderColor: snackbarColor || t.colors.border,
              alignSelf: 'center',
            }}
            theme={{ colors: { onSurface: t.colors.text } }}
            action={{ label: 'OK', onPress: () => setSnackbarVisible(false) }}
          >
            <Text style={{ color: t.colors.text, textAlign: 'center', fontSize: 15 }}>
              {snackbarMessage}
            </Text>
          </Snackbar>

          {confettiVisible && (
            <ConfettiCannon
              count={75}
              origin={{ x: width / 2, y: -20 }}
              explosionSpeed={500}
              fallSpeed={1700}
              fadeOut
              autoStart={false}
              ref={confettiRef}
            />
          )}
        </ScrollView>
      </View>
    </Screen>
  );
}

function StatCell({ t, label, value, accent }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent:'center', paddingVertical: 4, paddingHorizontal: 6 }}>
      <Text
        style={[
          t.typography.micro,
          {
            color: t.colors.textMuted,
            textTransform: 'uppercase',
            letterSpacing: 1.1,
            marginBottom: 6,
          },
        ]}
      >
        {label}
      </Text>
      <AutoFitText
        style={[
          t.typography.numeric,
          { color: accent ? t.colors.accent : t.colors.text }
        ]}
      >
        {value}
      </AutoFitText>
    </View>
  );
}

function DividerCell({ t }) {
  return (
    <View
      style={{
        width: StyleSheet.hairlineWidth,
        backgroundColor: t.colors.divider,
        marginVertical: 4,
      }}
    />
  );
}
