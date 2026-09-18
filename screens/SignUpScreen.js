// SignUpScreen — username with live availability hint, email, password (show/hide), inline validation.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, TextInput, Keyboard, TouchableWithoutFeedback, Pressable, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { doc, setDoc, query, where, getDocs, collection } from 'firebase/firestore';

import { auth, db } from '../utils/firebase';
import { saveUserPoints } from '../utils/firestore';
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
  const checkTimer = useRef(null);

  // Live username availability (debounced).
  useEffect(() => {
    const u = username.trim();
    if (checkTimer.current) clearTimeout(checkTimer.current);
    if (!u) {
      setAvailability(null);
      return undefined;
    }
    if (u.length > 16 || !/^[a-zA-Z0-9_.-]+$/.test(u)) {
      setAvailability('invalid');
      return undefined;
    }
    setAvailability('checking');
    checkTimer.current = setTimeout(async () => {
      try {
        const snap = await getDocs(query(collection(db, 'users'), where('username', '==', u)));
        setAvailability(snap.empty ? 'free' : 'taken');
      } catch {
        setAvailability(null);
      }
    }, 500);
    return () => checkTimer.current && clearTimeout(checkTimer.current);
  }, [username]);

  const hint = {
    checking: 'Checking…',
    free: 'Available',
    taken: 'Already taken',
    invalid: 'Up to 16 letters, numbers, dots, dashes or underscores.',
  }[availability] || 'Shown on the leaderboard. Up to 16 characters.';

  const handleSignUp = async () => {
    const u = username.trim();
    const e = email.trim();
    setError(null);
    if (!u) return setError('Choose a username.');
    if (availability === 'invalid' || u.length > 16) return setError('Username: up to 16 letters, numbers, dots, dashes or underscores.');
    if (availability === 'taken') return setError('That username is already taken.');
    if (!isValidEmail(e)) return setError('Enter a valid email address.');
    if (password.length < 6) return setError('Password must be at least 6 characters.');
    setBusy(true);
    try {
      const taken = await getDocs(query(collection(db, 'users'), where('username', '==', u)));
      if (!taken.empty) {
        setError('That username is already taken.');
        return;
      }
      const cred = await createUserWithEmailAndPassword(auth, e, password);
      const uid = cred.user.uid;
      await setDoc(doc(db, 'users', uid), { username: u, points: 0, drivingStreak: 0, photoURL: null, groupId: null });
      await setDoc(doc(db, 'userinfo', uid), { email: e, createdAt: new Date() });
      await saveUserPoints(uid, 0);
      // RootNavigator shows onboarding on auth change.
    } catch (err) {
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
                    maxLength={16}
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
