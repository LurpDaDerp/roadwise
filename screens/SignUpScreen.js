// SignUpScreen — username with live availability hint, email, password (show/hide),
// inline validation. Provisioning follows the backend data layer: a registry
// pre-flight (works while signed out), the auth account, a transactional username
// claim, then ensureUserProfile; any failure after the account exists deletes it.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Keyboard, TouchableWithoutFeedback, Pressable, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { createUserWithEmailAndPassword, deleteUser } from 'firebase/auth';

import { auth } from '../utils/firebase';
import { claimUsername, ensureUserProfile, isUsernameAvailable, validateUsername, MAX_USERNAME_LENGTH } from '../utils/firestore';
import { Screen, Section, Button, Field, Eyebrow, Banner, useInputStyle, useTheme } from '../theme';

const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.toLowerCase());

export default function SignUpScreen({ navigation }) {
  const t = useTheme();
  const inputStyle = useInputStyle();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [availability, setAvailability] = useState(null); // null | 'checking' | 'free' | 'taken' | 'invalid'
  const [usernameProblem, setUsernameProblem] = useState(null);
  const checkTimer = useRef(null);

  // Live availability against the public username registry (debounced).
  useEffect(() => {
    const u = username.trim();
    if (checkTimer.current) clearTimeout(checkTimer.current);
    if (!u) {
      setAvailability(null);
      setUsernameProblem(null);
      return undefined;
    }
    const problem = validateUsername(u);
    if (problem) {
      setAvailability('invalid');
      setUsernameProblem(problem);
      return undefined;
    }
    setUsernameProblem(null);
    setAvailability('checking');
    checkTimer.current = setTimeout(async () => {
      const free = await isUsernameAvailable(u);
      setAvailability(free ? 'free' : 'taken');
    }, 500);
    return () => checkTimer.current && clearTimeout(checkTimer.current);
  }, [username]);

  const hint =
    {
      checking: 'Checking…',
      free: 'Available',
      taken: 'Already taken',
      invalid: usernameProblem,
    }[availability] || `Shown on the leaderboard. Up to ${MAX_USERNAME_LENGTH} characters, starting with a letter or number.`;

  const handleSignUp = async () => {
    const u = username.trim();
    const e = email.trim();
    setError(null);
    const problem = validateUsername(u);
    if (problem) return setError(problem);
    if (availability === 'taken') return setError('That username is already taken.');
    if (!isValidEmail(e)) return setError('Enter a valid email address.');
    if (password.length < 6) return setError('Password must be at least 6 characters.');
    setBusy(true);
    let createdUser = null;
    try {
      if (!(await isUsernameAvailable(u))) {
        setError('That username is already taken.');
        return;
      }
      const cred = await createUserWithEmailAndPassword(auth, e, password);
      createdUser = cred.user;
      // Authoritative, race-free claim: exactly one of two simultaneous sign-ups wins.
      const claimed = await claimUsername(createdUser.uid, u);
      if (!claimed) {
        await deleteUser(createdUser).catch(() => {});
        setError('That username was just taken. Please choose another.');
        return;
      }
      await ensureUserProfile(createdUser, { username: u });
      // RootNavigator shows onboarding on auth change.
    } catch (err) {
      // Anything that fails after the auth account exists leaves an orphan; remove it.
      if (createdUser && err?.code !== 'auth/email-already-in-use') {
        await deleteUser(createdUser).catch(() => {});
      }
      if (err?.code === 'auth/email-already-in-use') setError('An account with this email already exists. Log in instead.');
      else if (err?.code === 'auth/invalid-email') setError('Enter a valid email address.');
      else if (err?.code === 'auth/weak-password') setError('Choose a stronger password (at least 6 characters).');
      else if (err?.code === 'auth/network-request-failed') setError('No connection. Check your network and try again.');
      else setError(err?.message || 'Could not create the account.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <Screen hasHeader>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 32 }}>
            <View style={{ marginTop: 8, marginBottom: 28 }}>
              <Eyebrow>Get started</Eyebrow>
              <Text style={[t.typography.display, { color: t.colors.text, marginTop: 10 }]}>Create account</Text>
              <Text style={[t.typography.body, { color: t.colors.textMuted, marginTop: 8 }]}>A few seconds, then you're on the road.</Text>
            </View>

            {!!error && <Banner tone="danger" body={error} style={{ marginBottom: 16 }} />}

            <Section>
              <Field label="Username" hint={hint}>
                <View>
                  <TextInput
                    placeholder="yourhandle"
                    placeholderTextColor={t.colors.textSubtle}
                    style={[inputStyle, { paddingRight: 40 }]}
                    value={username}
                    onChangeText={setUsername}
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={MAX_USERNAME_LENGTH}
                  />
                  {(availability === 'free' || availability === 'taken') && (
                    <View style={{ position: 'absolute', right: 12, top: 0, bottom: 0, justifyContent: 'center' }}>
                      <Ionicons name={availability === 'free' ? 'checkmark-circle' : 'close-circle'} size={20} color={availability === 'free' ? t.colors.success : t.colors.danger} />
                    </View>
                  )}
                </View>
              </Field>
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
                />
              </Field>
              <Field label="Password" hint="At least 6 characters.">
                <View>
                  <TextInput
                    placeholder="Create a password"
                    placeholderTextColor={t.colors.textSubtle}
                    style={[inputStyle, { paddingRight: 46 }]}
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry={!showPassword}
                    textContentType="newPassword"
                    onSubmitEditing={handleSignUp}
                  />
                  <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={8} accessibilityRole="button" accessibilityLabel={showPassword ? 'Hide password' : 'Show password'} style={{ position: 'absolute', right: 12, top: 0, bottom: 0, justifyContent: 'center' }}>
                    <Ionicons name={showPassword ? 'eye-off-outline' : 'eye-outline'} size={20} color={t.colors.textMuted} />
                  </Pressable>
                </View>
              </Field>

              <Button title="Create account" onPress={handleSignUp} loading={busy} />
            </Section>

            <View style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center', marginTop: 4 }}>
              <Text style={[t.typography.body, { color: t.colors.textMuted }]}>Already have one?</Text>
              <Text onPress={() => navigation.replace('Login')} style={[t.typography.bodyStrong, { color: t.colors.accent, marginLeft: 6 }]}>
                Log in
              </Text>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </Screen>
    </TouchableWithoutFeedback>
  );
}
