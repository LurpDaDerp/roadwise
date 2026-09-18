// LoginScreen — email + password (show/hide), inline errors, forgot password, Google.
import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Keyboard, TouchableWithoutFeedback, Pressable, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { signInWithEmailAndPassword, sendPasswordResetEmail, GoogleAuthProvider, signInWithCredential } from 'firebase/auth';
import * as Google from 'expo-auth-session/providers/google';

import { auth } from '../utils/firebase';
import { Screen, Section, Button, Field, Eyebrow, Banner, useInputStyle, useTheme } from '../theme';

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

  const [request, response, promptAsync] = Google.useIdTokenAuthRequest({
    clientId: '68093599355-ps82c8m515nrpsont9mhgl2bv7k85b49.apps.googleusercontent.com',
  });

  useEffect(() => {
    if (response?.type === 'success') {
      const { id_token } = response.params;
      const credential = GoogleAuthProvider.credential(id_token);
      signInWithCredential(auth, credential).catch((e) => setError(e?.message || 'Google sign-in failed.'));
    } else if (response?.type === 'error') {
      setError('Google sign-in failed.');
    }
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
                disabled={!request || busy}
                onPress={() => promptAsync()}
                icon={<Ionicons name="logo-google" size={18} color={t.colors.text} />}
              />
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
