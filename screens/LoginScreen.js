//LoginScreen.js
import React, { useState, useEffect, useLayoutEffect } from 'react';
import {
  View, Text, TextInput, StyleSheet, Alert, Keyboard, TouchableWithoutFeedback,
} from 'react-native';
import { auth } from '../utils/firebase';
import {
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithCredential,
} from 'firebase/auth';
import * as Google from 'expo-auth-session/providers/google';
import { useNavigation } from '@react-navigation/native';
import {
  Screen,
  Section,
  Button,
  Field,
  Eyebrow,
  useInputStyle,
  useTheme,
} from '../theme';

export default function LoginScreen() {
  const navigation = useNavigation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const t = useTheme();
  const inputStyle = useInputStyle();

  useLayoutEffect(() => {
    navigation.getParent()?.setOptions({
      tabBarStyle: { display: 'none' },
    });
    return () => {
      navigation.getParent()?.setOptions({
        tabBarStyle: { display: 'flex' },
      });
    };
  }, [navigation]);

  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    clientId: '68093599355-ps82c8m515nrpsont9mhgl2bv7k85b49.apps.googleusercontent.com',
  });

  useEffect(() => {
    if (response?.type === 'success') {
      const { id_token } = response.params;
      const credential = GoogleAuthProvider.credential(id_token);
      signInWithCredential(auth, credential)
        .then(async () => {
          const tabNav = navigation.getParent();
          if (tabNav) {
            tabNav.navigate('Settings', {
              screen: 'SettingsMain',
              params: { reset: true },
            });
          }
          navigation.reset({
            index: 0,
            routes: [{ name: 'Dashboard' }],
          });
        })
        .catch((error) => {
          Alert.alert('Google Sign-In Failed', error.message);
        });
    }
  }, [response]);

  const handleLogin = async () => {
    const emailTrimmed = email.trim();
    if (!emailTrimmed || !password) {
      Alert.alert('Missing info', 'Please enter email and password.');
      return;
    }

    try {
      await signInWithEmailAndPassword(auth, emailTrimmed, password);
      navigation.reset({
        index: 0,
        routes: [{ name: 'Dashboard' }],
      });
    } catch (err) {
      let message = 'Login failed. Please try again.';
      if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password') {
        message = 'Incorrect email or password.';
      } else if (err.code === 'auth/user-not-found') {
        message = 'No account found for that email.';
      } else if (err.code === 'auth/too-many-requests') {
        message = 'Too many attempts. Please wait and try again.';
      }
      Alert.alert('Couldn’t log in', message);
    }
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <Screen>
        <View style={{ marginTop: 48, marginBottom: 40 }}>
          <Eyebrow>Welcome back</Eyebrow>
          <Text style={[t.typography.display, { color: t.colors.text, marginTop: 10 }]}>
            RoadWise
          </Text>
          <Text style={[t.typography.body, { color: t.colors.textMuted, marginTop: 8 }]}>
            Sign in to track drives, earn points, and redeem rewards.
          </Text>
        </View>

        <Section>
          <Field label="Email">
            <TextInput
              placeholder="you@example.com"
              placeholderTextColor={t.colors.textSubtle}
              style={inputStyle}
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
            />
          </Field>
          <Field label="Password">
            <TextInput
              placeholder="••••••••"
              placeholderTextColor={t.colors.textSubtle}
              style={inputStyle}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />
          </Field>

          <Button title="Log In" onPress={handleLogin} />

          <View style={{ height: 12 }} />

          <Button
            title="Continue with Google"
            variant="ghost"
            disabled={!request}
            onPress={() => promptAsync()}
          />
        </Section>

        <View style={styles.footerRow}>
          <Text style={[t.typography.body, { color: t.colors.textMuted }]}>
            New to RoadWise?
          </Text>
          <Text
            onPress={() => navigation.navigate('SignUp')}
            style={[
              t.typography.bodyStrong,
              { color: t.colors.accent, marginLeft: 6 },
            ]}
          >
            Create account
          </Text>
        </View>
      </Screen>
    </TouchableWithoutFeedback>
  );
}

const styles = StyleSheet.create({
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 12,
  },
});
