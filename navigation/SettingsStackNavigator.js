import React from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import SettingsScreen from '../screens/SettingsScreen';
import DriveScreenSettings from '../screens/DriveScreenSettings';
import GeneralSettings from '../screens/GeneralSettings';
import SafetySettings from '../screens/SafetySettings'
import AccountSettings from '../screens/AccountSettings';

const Stack = createStackNavigator();

export default function SettingsStackNavigator() {
  return (
    <Stack.Navigator initialRouteName="SettingsMain">
      <Stack.Screen
        name="SettingsMain"
        component={SettingsScreen}
        options={{ headerShown: false, headerTitle: "Settings" }}
      />
      <Stack.Screen
        name="DriveScreenSettings"
        component={DriveScreenSettings}
        options={{ headerTransparent: true, headerTitle: '' }}
      />
      <Stack.Screen
        name="GeneralSettings"
        component={GeneralSettings}
        options={{ headerTransparent: true, headerTitle: '' }}
      />
      <Stack.Screen
        name="SafetySettings"
        component={SafetySettings}
        options={{ headerTransparent: true, headerTitle: '' }}
      />
      <Stack.Screen
        name="AccountSettings"
        component={AccountSettings}
        options={{ headerTransparent: true, headerTitle: '' }}
      />
    </Stack.Navigator>
  );
}
