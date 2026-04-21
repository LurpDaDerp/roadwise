// StackNavigator.js
import React, { useEffect, useState } from 'react';
import { createStackNavigator } from '@react-navigation/stack';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../utils/firebase';

import DashboardScreen from '../screens/DashboardScreen';
import DriveScreen from '../screens/DriveScreen';
import SettingsStackNavigator from './SettingsStackNavigator';
import LoginScreen from '../screens/LoginScreen';
import SignUpScreen from '../screens/SignUpScreen';
import MyDrivesScreen from '../screens/MyDrivesScreen';
import AboutScreen from '../screens/AboutScreen';
import AIScreen from '../screens/AIScreen';
import AIFeedbackScreen from '../screens/AIFeedbackScreen';
import LocationScreen from '../screens/LocationScreen';
const Stack = createStackNavigator();

export default function StackNavigator() {
  const [initializing, setInitializing] = useState(true);
  const [user, setUser] = useState(null);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      setUser(firebaseUser);
      if (initializing) setInitializing(false);
    });
    return () => unsubscribe();
  }, []);

  if (initializing) return null; 

  return (
    <Stack.Navigator>
      {user ? (
        <>
          <Stack.Screen name="Home" component={DashboardScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Drive" component={DriveScreen} options={{ headerShown: false, gestureEnabled: false }} />
          <Stack.Screen name="SettingsStack" component={SettingsStackNavigator} options={{ headerShown: false }} />
          <Stack.Screen name="MyDrives" component={MyDrivesScreen}options={{headerTransparent: true, headerTitle: "", headerBackTitle: 'Back'}} />
          <Stack.Screen name="AIScreen" component={AIScreen} options={{headerTransparent: true, headerTitle: ""}}/>
          <Stack.Screen name="AIFeedback" component={AIFeedbackScreen} options={{headerTransparent: true, headerTitle: "", headerBackTitle: 'Back'}}/>
          <Stack.Screen name="LocationScreen" component={LocationScreen} options={{headerTransparent: true, headerTitle: ""}}/>
          <Stack.Screen name="About" component={AboutScreen} />
        </>
      ) : (
        <>
          <Stack.Screen name="Login" component={LoginScreen} options={{ headerTransparent: true, headerTitle: '' }} />
          <Stack.Screen name="SignUp" component={SignUpScreen} options={{ headerTransparent: true, headerTitle: '' }} />
        </>
      )}
    </Stack.Navigator>
  );
}
