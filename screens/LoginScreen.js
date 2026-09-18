// LoginScreen — email + password (show/hide), inline errors, forgot password, Google.
// Google sign-in follows the backend data layer: per-platform client ids from
// utils/config.js, maybeCompleteAuthSession, non-success results surfaced, the button
// disabled with a notice when the build has no client ids, ensureUserProfile after.
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Keyboard, TouchableWithoutFeedback, Pressable, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { signInWithEmailAndPassword, sendPasswordResetEmail, GoogleAuthProvider, signInWithCredential } from 'firebase/auth';
import * as Google from 'expo-auth-session/providers/google';
import * as WebBrowser from 'expo-web-browser';

import { auth } from '../utils/firebase';
import { googleAuthConfig } from '../utils/config';
import { ensureUserProfile } from '../utils/firestore';
import { Screen, Section, Button, Field, Eyebrow, Banner, useInputStyle, useTheme } from '../theme';

// Required by expo-auth-session so the browser tab closes and hands control back to the
// app once Google redirects; without it the response can never be delivered.
WebBrowser.maybeCompleteAuthSession();

function authMessage(code) {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect email or password.';
    case 'auth/invalid-email':
      return 'That email address does not look right.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'auth/network-request-failed':
      return 'No connection. Check your network and try again.';
    default:
      return 'Could not log in. Please try again.';
  }
}

export default function LoginScreen({ navigation }) {
  const t = useTheme();
  const inputStyle = useInputStyle();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  // One OAuth client id PER PLATFORM: a native build redirects to its own URL scheme and
  // Google rejects a redirect that does not belong to the client id used. The web id is
  // still passed because it is the audience Firebase validates the id token against.
  const platformClientId = Platform.OS === 'ios' ? googleAuthConfig.iosClientId : googleAuthConfig.androidClientId;
  const googleConfigured = Boolean(googleAuthConfig.webClientId && platformClientId);

  // The hook throws during render without any usable client id; a stub keeps the screen
  // renderable so the "not configured" notice can show.
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
    if (response.type === 'error') {
      setError(response.error?.message ?? 'Google rejected the sign-in request. Check the OAuth client id for this platform.');
      return;
    }
    if (response.type !== 'success') return; // dismissed / cancelled
    const idToken = response.params?.id_token ?? response.authentication?.idToken;
    if (!idToken) {
      setError('Google did not return an identity token.');
      return;
    }
    setBusy(true);
    signInWithCredential(auth, GoogleAuthProvider.credential(idToken))
      .then(async ({ user }) => {
        // A Google account has no profile document yet; create one (and a username claim).
        await ensureUserProfile(user);
      })
      .catch((e) => setError(e?.message || 'Google sign-in failed.'))
      .finally(() => setBusy(false));
  }, [response]);

  const handleLogin = async () => {
    const e = email.trim();
    setError(null);
    setNotice(null);
    if (!e || !password) {
      setError('Enter your email and password.');
      return;
    }
    setBusy(true);
    try {
      await signInWithEmailAndPassword(auth, e, password);
      // RootNavigator switches to the app on auth change.
    } catch (err) {
      setError(authMessage(err?.code));
    } finally {
      setBusy(false);
    }
  };

  const handleForgot = async () => {
    const e = email.trim();
    setError(null);
    if (!e) {
      setError('Enter your email above and tap "Forgot password" again.');
      return;
    }
    try {
      await sendPasswordResetEmail(auth, e);
      setNotice(`Reset link sent to ${e}.`);
    } catch (err) {
      setError(authMessage(err?.code));
    }
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <Screen hasHeader>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
            <View style={{ marginTop: 8, marginBottom: 28 }}>
              <Eyebrow>Welcome back</Eyebrow>
              <Text style={[t.typography.display, { color: t.colors.text, marginTop: 10 }]}>Log in</Text>
              <Text style={[t.typography.body, { color: t.colors.textMuted, marginTop: 8 }]}>Your points, streak and drives are waiting.</Text>
            </View>

            {!!error && <Banner tone="danger" body={error} style={{ marginBottom: 16 }} />}
            {!!notice && <Banner tone="success" body={notice} style={{ marginBottom: 16 }} />}

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
                  autoComplete="email"
                  textContentType="emailAddress"
                  returnKeyType="next"
                />
              </Field>
              <Field label="Password">
                <View>
                  <TextInput
                    placeholder="Your password"
                    placeholderTextColor={t.colors.textSubtle}
                    style={[inputStyle, { paddingRight: 46 }]}
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry={!showPassword}
                    autoComplete="password"
                    textContentType="password"
                    returnKeyType="go"
                    onSubmitEditing={handleLogin}
                  />
                  <Pressable
                    onPress={() => setShowPassword((v) => !v)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={showPassword ? 'Hide password' : 'Show password'}
                    style={{ position: 'absolute', right: 12, top: 0, bottom: 0, justifyContent: 'center' }}
                  >
                    <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={20} color={t.colors.textMuted} />
                  </Pressable>
                </View>
              </Field>

              <Pressable onPress={handleForgot} hitSlop={6} style={{ alignSelf: 'flex-end', marginTop: -6, marginBottom: 16 }}>
                <Text style={[t.typography.caption, { color: t.colors.accent, fontWeight: '700' }]}>Forgot password?</Text>
              </Pressable>

              <Button title="Log in" onPress={handleLogin} loading={busy} />
              <View style={{ height: 12 }} />
              <Button
                title="Continue with Google"
                variant="ghost"
                disabled={!request || !googleConfigured || busy}
                onPress={() => promptAsync()}
                icon={<Ionicons name="logo-google" size={18} color={t.colors.text} />}
              />
              {!googleConfigured && (
                <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 8, textAlign: 'center' }]}>
                  Google sign-in is not configured for this build.
                </Text>
              )}
            </Section>

            <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: 4 }}>
              <Text style={[t.typography.body, { color: t.colors.textMuted }]}>New to RoadWise?</Text>
              <Text onPress={() => navigation.replace('SignUp')} style={[t.typography.bodyStrong, { color: t.colors.accent, marginLeft: 6 }]}>
                Create account
              </Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Screen>
    </TouchableWithoutFeedback>
  );
}
