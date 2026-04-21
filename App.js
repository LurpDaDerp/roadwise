// App.js
import React, { useRef, useEffect } from 'react';
import { AppState, useColorScheme, Dimensions, View } from 'react-native';

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  NavigationContainer,
  useNavigationContainerRef,
  DarkTheme,
  DefaultTheme,
  createNavigationContainerRef
} from '@react-navigation/native';
import { createDrawerNavigator } from '@react-navigation/drawer';
import { MaterialIcons } from '@expo/vector-icons'; 
import { Ionicons } from '@expo/vector-icons';

import StackNavigator from './navigation/StackNavigator';
import SettingsStackNavigator from './navigation/SettingsStackNavigator';
import MyDrivesScreen from './screens/MyDrivesScreen';
import RewardsStackNavigator from './navigation/RewardsStackNavigator';
import LeaderboardScreen from './screens/LeaderboardScreen';
import AboutScreen from './screens/AboutScreen';

import { ThemeProvider } from './context/ThemeContext';
import { useContext } from 'react';
import { ThemeContext } from './context/ThemeContext';
import { DriveProvider } from './context/DriveContext'
import { ErrorBoundary } from './theme';

import { Provider as PaperProvider } from 'react-native-paper';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import * as Notifications from 'expo-notifications';
import RewardsScreen from './screens/RewardsScreen';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import { startLocationUpdates } from './utils/LocationService';

import { 
  requestNotificationPermissions, 
  registerForPushNotificationsAsync 
} from "./utils/notifications";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,  
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});
const Drawer = createDrawerNavigator();

const { width, height } = Dimensions.get('window');

const Tab = createBottomTabNavigator();

export const tabNavRef = createNavigationContainerRef();

function AppNavigation() {
  const appState = useRef(AppState.currentState);
  const navigationRef = useNavigationContainerRef();
  const { resolvedTheme } = useContext(ThemeContext);
  const isDark = resolvedTheme === 'dark';

  React.useEffect(() => {
    const setupNotifications = async () => {
      const granted = await requestNotificationPermissions();
      if (granted) {
        await registerForPushNotificationsAsync();
      }
    };
    setupNotifications();
  }, []);

  React.useEffect(() => {
    const subResponse = Notifications.addNotificationResponseReceivedListener((response) => {
      if (navigationRef.isReady()) {
        const emergencyUid =
          response?.notification?.request?.content?.data?.emergencyUid || null;

        const route = navigationRef.current?.getCurrentRoute();
        if (route?.name !== "Drive" && route?.name !== "SettingsMain") {
          navigationRef.navigate("LocationScreen", { emergencyUid });
        }
      }
    });

    return () => {
      subResponse.remove();
    };
  }, []);



  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', async (nextAppState) => {
      if (appState.current === 'active' && nextAppState.match(/inactive|background/)) {
        await AsyncStorage.setItem('lastBackgroundTime', Date.now().toString());
      }

      if (appState.current.match(/inactive|background/) && nextAppState === 'active') {
        const stored = await AsyncStorage.getItem('lastBackgroundTime');
        const now = Date.now();

        if (stored) {
          const diffMinutes = (now - parseInt(stored, 10)) / 1000 / 60;
          if (diffMinutes >= 10 && navigationRef.isReady()) {
            navigationRef.reset({
              index: 0,
              routes: [
                {
                  name: 'Dashboard',
                  state: {
                    routes: [{ name: 'Dashboard' }],
                  },
                },
              ],
            });
          }
        }
      }

      appState.current = nextAppState;
    });

    return () => subscription.remove();
  }, [navigationRef]);

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={resolvedTheme === 'dark' ? DarkTheme : DefaultTheme}
    >
      <Tab.Navigator
        ref={tabNavRef}
        initialRouteName="Dashboard"
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarShowLabel: false, 
          tabBarIconStyle: {
            marginTop: 5,  
            marginBottom: 5, 
          },
          tabBarActiveTintColor: resolvedTheme === "dark" ? "#fff" : "#000",
          tabBarInactiveTintColor: "gray",
          tabBarIcon: ({ color, size }) => {
            let iconName;
            if (route.name === "Dashboard") iconName = "home";
            else if (route.name === "Rewards") iconName = "card-giftcard";
            else if (route.name === "Leaderboard") iconName = "leaderboard";
            else if (route.name === "Settings") iconName = "settings";
            else if (route.name === "About") iconName = "info-outline";
            return <MaterialIcons name={iconName} size={size} color={color} />;
          },
        })}
      >
        
        <Tab.Screen name="Rewards" component={RewardsStackNavigator} />
        <Tab.Screen name="Leaderboard" component={LeaderboardScreen} />
        <Tab.Screen name="Dashboard" component={StackNavigator}/>
        <Tab.Screen name="Settings" component={SettingsStackNavigator} />
        <Tab.Screen name="About" component={AboutScreen} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}



export default function App() {

  useEffect(() => {
    startLocationUpdates(); 
  }, []);

  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <DriveProvider>
          <ThemeProvider>
            <PaperProvider>
              <AppNavigation />
            </PaperProvider>
          </ThemeProvider>
        </DriveProvider>
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}