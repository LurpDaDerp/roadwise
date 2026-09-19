// MainTabs — Home · Drives · Rewards · Family · Settings.
// Full-screen flows (Drive, DriveSummary, Onboarding, Auth) and DriveDetail live in
// RootNavigator, so no screen needs to hide the tab bar by hand, and a drive opened from
// Home returns to Home instead of hijacking the Drives tab.
import React from 'react';
import { Platform } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '../theme';

import HomeScreen from '../screens/HomeScreen';
import DrivesScreen from '../screens/DrivesScreen';
import AIFeedbackScreen from '../screens/AIFeedbackScreen';
import RewardsScreen from '../screens/RewardsScreen';
import LeaderboardScreen from '../screens/LeaderboardScreen';
import FamilyScreen from '../screens/FamilyScreen';
import SettingsScreen from '../screens/SettingsScreen';
import AccountSettings from '../screens/AccountSettings';
import DriveScreenSettings from '../screens/DriveScreenSettings';
import MonitoringSettings from '../screens/MonitoringSettings';
import SafetySettings from '../screens/SafetySettings';
import NotificationSettings from '../screens/NotificationSettings';
import AboutScreen from '../screens/AboutScreen';

const Tab = createBottomTabNavigator();
const DrivesStack = createNativeStackNavigator();
const RewardsStack = createNativeStackNavigator();
const SettingsStack = createNativeStackNavigator();

function useStackOptions() {
  const t = useTheme();
  return {
    headerShown: true,
    // Opaque: a transparent header let every pushed screen's title and scrolled content slide
    // under the back button (the screens only padded 32 pt for a 44-56 pt header).
    headerTransparent: false,
    headerStyle: { backgroundColor: t.colors.bg },
    headerTitle: '',
    headerBackTitle: 'Back',
    headerTintColor: t.colors.accent,
    headerShadowVisible: false,
    contentStyle: { backgroundColor: t.colors.bg },
  };
}

function DrivesNavigator() {
  const opts = useStackOptions();
  return (
    <DrivesStack.Navigator screenOptions={opts}>
      <DrivesStack.Screen name="DrivesHome" component={DrivesScreen} options={{ headerShown: false }} />
      <DrivesStack.Screen name="AIFeedback" component={AIFeedbackScreen} />
    </DrivesStack.Navigator>
  );
}

function RewardsNavigator() {
  const opts = useStackOptions();
  return (
    <RewardsStack.Navigator screenOptions={opts}>
      <RewardsStack.Screen name="RewardsHome" component={RewardsScreen} options={{ headerShown: false }} />
      <RewardsStack.Screen name="Leaderboard" component={LeaderboardScreen} />
    </RewardsStack.Navigator>
  );
}

function SettingsNavigator() {
  const opts = useStackOptions();
  return (
    <SettingsStack.Navigator screenOptions={opts}>
      <SettingsStack.Screen name="SettingsHome" component={SettingsScreen} options={{ headerShown: false }} />
      <SettingsStack.Screen name="AccountSettings" component={AccountSettings} />
      <SettingsStack.Screen name="DriveScreenSettings" component={DriveScreenSettings} />
      <SettingsStack.Screen name="MonitoringSettings" component={MonitoringSettings} />
      <SettingsStack.Screen name="SafetySettings" component={SafetySettings} />
      <SettingsStack.Screen name="NotificationSettings" component={NotificationSettings} />
      <SettingsStack.Screen name="About" component={AboutScreen} />
    </SettingsStack.Navigator>
  );
}

const ICONS = {
  Home: ['home', 'home-outline'],
  Drives: ['car-sport', 'car-sport-outline'],
  Rewards: ['gift', 'gift-outline'],
  Family: ['people', 'people-outline'],
  Settings: ['settings', 'settings-outline'],
};

export default function MainTabs() {
  const t = useTheme();
  return (
    <Tab.Navigator
      initialRouteName="Home"
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: t.colors.accent,
        tabBarInactiveTintColor: t.colors.textSubtle,
        tabBarStyle: {
          backgroundColor: t.colors.bgElevated,
          borderTopColor: t.colors.border,
          height: Platform.OS === 'ios' ? 84 : 66,
          paddingTop: 6,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '700', letterSpacing: 0.2, marginBottom: Platform.OS === 'ios' ? 0 : 8 },
        tabBarIcon: ({ color, size, focused }) => {
          const [on, off] = ICONS[route.name] || ['ellipse', 'ellipse-outline'];
          return <Ionicons name={focused ? on : off} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} />
      <Tab.Screen name="Drives" component={DrivesNavigator} />
      <Tab.Screen name="Rewards" component={RewardsNavigator} />
      <Tab.Screen name="Family" component={FamilyScreen} />
      <Tab.Screen name="Settings" component={SettingsNavigator} />
    </Tab.Navigator>
  );
}
