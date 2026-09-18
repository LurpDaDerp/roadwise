//LoginScreen.js
import React, { useState, useEffect, useLayoutEffect } from 'react';
import {
  View, Text, TextInput, StyleSheet, Alert, Keyboard, TouchableWithoutFeedback, Platform,
} from 'react-native';
import { auth } from '../utils/firebase';
import {
  signInWithEmailAndPassword,
  GoogleAuthProvider,
  signInWithCredential,
} from 'firebase/auth';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';
import { useNavigation } from '@react-navigation/native';
import { googleAuthConfig } from '../utils/config';
import { ensureUserProfile } from '../utils/firestore';
import {
  Screen,
  Section,
  Button,
  Field,
  Eyebrow,
  useInputStyle,
  useTheme,
} from '../theme';

// Required by expo-auth-session so the browser tab closes and hands control back to the
// app once Google redirects. Without it the sign-in sheet can sit open after a successful
// authentication and the response is never delivered.
WebBrowser.maybeCompleteAuthSession();

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

  // Google sign-in needs one OAuth client id PER PLATFORM, not just the web one.
  // A native build redirects to its own URL scheme (the reversed iOS client id, or the
  // package name plus signing certificate on Android), and Google rejects a redirect that
  // does not belong to the client id the request was made with - which is why the previous
  // single-web-client-id version never came back with a result. The web client id is still
  // passed because it is the audience Firebase validates the id token against.
  const platformClientId =
    Platform.OS === 'ios' ? googleAuthConfig.iosClientId : googleAuthConfig.androidClientId;
  const googleConfigured = Boolean(googleAuthConfig.webClientId && platformClientId);

  // The hook throws during render if it is given no usable client id at all, which would
  // take the whole login screen down before the "not configured" notice could be shown.
  // Passing a config only when one exists keeps the screen renderable either way.
  const [request, response, promptAsync] = Google.useIdTokenAuthRequest(
    googleConfigured
      ? {
          clientId: googleAuthConfig.webClientId,
          iosClientId: googleAuthConfig.iosClientId ?? undefined,
          androidClientId: googleAuthConfig.androidClientId ?? undefined,
          webClientId: googleAuthConfig.webClientId,
        }
      : { clientId: 'unconfigured.apps.googleusercontent.com' }
  );

  useEffect(() => {
    if (!response) return;

    // Failures used to be silent: only 'success' was handled, so a rejected redirect or a
    // dismissed sheet left the button looking like it had done nothing.
    if (response.type === 'error') {
      Alert.alert(
        'Google Sign-In Failed',
        response.error?.message ??
          'Google rejected the sign-in request. Check that the OAuth client id for this platform exists and that its redirect URI matches the app.'
      );
      return;
    }
    if (response.type !== 'success') return;

    const idToken = response.params?.id_token ?? response.authentication?.idToken;
    if (!idToken) {
      Alert.alert('Google Sign-In Failed', 'Google did not return an identity token.');
      return;
    }

    const credential = GoogleAuthProvider.credential(idToken);
    signInWithCredential(auth, credential)
      .then(async ({ user }) => {
        // A Google account has no profile document yet; create one (and a username claim)
        // before any screen tries to read it.
        await ensureUserProfile(user);

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
  }, [response, navigation]);

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
            disabled={!request || !googleConfigured}
            onPress={() => promptAsync()}
          />
          {!googleConfigured && (
            <Text
              style={[
                t.typography.caption,
                { color: t.colors.textMuted, marginTop: 8, textAlign: 'center' },
              ]}
            >
              Google sign-in is not configured for this build.
            </Text>
          )}
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
