// RootNavigator — the auth gate and the full-screen flows.
//   signed out           → Welcome / Login / SignUp
//   signed in, first run → Onboarding
//   otherwise            → Main tabs, with DrivePrep / Drive / DriveSummary
//                          presented over them (no tab bar, no swipe back)
import React, { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { NavigationContainer, DarkTheme, DefaultTheme, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';

import { useTheme } from '../theme';
import { useAuthContext } from '../context/AuthContext';
import { ensureLocationSharing } from '../utils/LocationService';
import { registerForPushNotificationsAsync } from '../utils/notifications';
import { flushPendingDriveWrites } from '../utils/firestore';
import { useSettings } from '../context/SettingsContext';

import MainTabs from './MainTabs';
import WelcomeScreen from '../screens/WelcomeScreen';
import LoginScreen from '../screens/LoginScreen';
import SignUpScreen from '../screens/SignUpScreen';
import OnboardingScreen from '../screens/OnboardingScreen';
import DrivePrepScreen from '../screens/DrivePrepScreen';
import DriveScreen from '../screens/DriveScreen';
import DriveSummaryScreen from '../screens/DriveSummaryScreen';

const Stack = createNativeStackNavigator();
export const navigationRef = createNavigationContainerRef();

function Splash() {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.colors.bg, alignItems: 'center', justifyContent: 'center' }}>
      <ActivityIndicator size="small" color={t.colors.accent} />
    </View>
  );
}

export default function RootNavigator() {
  const t = useTheme();
  const { user, initializing, onboarded, groupId } = useAuthContext();
  const { settings, ready: settingsReady } = useSettings();

  // Upload anything a previous session finished but could not send (the queue is
  // also drained when a drive starts, in useDriveSession).
  useEffect(() => {
    if (!user?.uid) return;
    flushPendingDriveWrites(user.uid).catch(() => {});
  }, [user?.uid]);

  // Family location sharing resumes for group members only when "Always"
  // location is already granted — never prompt at cold start; create / join
  // asks explicitly (components/family/useFamilyGroup.js).
  useEffect(() => {
    if (!user || !groupId) return;
    let cancelled = false;
    (async () => {
      try {
        const bg = await Location.getBackgroundPermissionsAsync();
        if (!cancelled && bg.status === 'granted') ensureLocationSharing();
      } catch {}
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.uid, groupId]);

  // Register the push token once notifications are allowed (no prompt here)
  // and only while family-emergency pushes are wanted.
  useEffect(() => {
    if (!user || !settingsReady || !settings.notifyFamilyEmergency) return;
    (async () => {
      try {
        const { status } = await Notifications.getPermissionsAsync();
        if (status === 'granted') await registerForPushNotificationsAsync();
      } catch {}
    })();
  }, [user?.uid, settingsReady, settings.notifyFamilyEmergency]);

  // Emergency push → Family tab.
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const emergencyUid = response?.notification?.request?.content?.data?.emergencyUid || null;
      if (!emergencyUid) return; // only emergency pushes deep-link; "Drive ended" etc. just open the app
      if (!navigationRef.isReady()) return;
      const route = navigationRef.getCurrentRoute();
      if (['Drive', 'DrivePrep', 'DriveSummary', 'Onboarding'].includes(route?.name)) return;
      navigationRef.navigate('Main', { screen: 'Family', params: { emergencyUid } });
    });
    return () => sub.remove();
  }, []);

  const navTheme = {
    ...(t.isDark ? DarkTheme : DefaultTheme),
    colors: {
      ...(t.isDark ? DarkTheme : DefaultTheme).colors,
      background: t.colors.bg,
      card: t.colors.bgElevated,
      text: t.colors.text,
      primary: t.colors.accent,
      border: t.colors.border,
    },
  };

  const loading = initializing || (user && onboarded === null);

  return (
    <NavigationContainer ref={navigationRef} theme={navTheme}>
      <Stack.Navigator screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.colors.bg } }}>
        {loading ? (
          <Stack.Screen name="Splash" component={Splash} />
        ) : !user ? (
          <Stack.Group screenOptions={{ animation: 'fade' }}>
            <Stack.Screen name="Welcome" component={WelcomeScreen} />
            <Stack.Screen
              name="Login"
              component={LoginScreen}
              options={{ headerShown: true, headerTransparent: true, headerTitle: '', headerTintColor: t.colors.accent, animation: 'slide_from_right' }}
            />
            <Stack.Screen
              name="SignUp"
              component={SignUpScreen}
              options={{ headerShown: true, headerTransparent: true, headerTitle: '', headerTintColor: t.colors.accent, animation: 'slide_from_right' }}
            />
          </Stack.Group>
        ) : onboarded === false ? (
          <Stack.Screen name="Onboarding" component={OnboardingScreen} options={{ animation: 'fade' }} />
        ) : (
          <>
            <Stack.Screen name="Main" component={MainTabs} options={{ animation: 'fade' }} />
            <Stack.Group screenOptions={{ presentation: 'fullScreenModal', gestureEnabled: false, animation: 'slide_from_bottom' }}>
              <Stack.Screen name="DrivePrep" component={DrivePrepScreen} />
              <Stack.Screen name="Drive" component={DriveScreen} options={{ animation: 'fade' }} />
              <Stack.Screen name="DriveSummary" component={DriveSummaryScreen} options={{ animation: 'fade' }} />
            </Stack.Group>
          </>
        )}
      </Stack.Navigator>
    </NavigationContainer>
  );
}
