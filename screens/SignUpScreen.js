import React, { useState } from 'react';
import { View, Text, TextInput, Alert, Keyboard, TouchableWithoutFeedback } from 'react-native';
import { auth } from '../utils/firebase';
import { createUserWithEmailAndPassword, deleteUser } from 'firebase/auth';
import { useNavigation } from '@react-navigation/native';
import {
  claimUsername,
  ensureUserProfile,
  isUsernameAvailable,
  validateUsername,
  MAX_USERNAME_LENGTH,
} from '../utils/firestore';
import {
  Screen,
  Section,
  Button,
  Field,
  Eyebrow,
  useInputStyle,
  useTheme,
} from '../theme';

export default function SignUpScreen() {
  const navigation = useNavigation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const t = useTheme();
  const inputStyle = useInputStyle();

  const isValidEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.toLowerCase());

  const handleSignUp = async () => {
    const trimmedUsername = username.trim();
    const trimmedEmail = email.trim();

    const usernameProblem = validateUsername(trimmedUsername);
    if (usernameProblem) {
      Alert.alert('Validation Error', usernameProblem);
      return;
    }
    if (!isValidEmail(trimmedEmail)) {
      Alert.alert('Validation Error', 'Please enter a valid email address.');
      return;
    }
    if (password.length < 6) {
      Alert.alert('Validation Error', 'Password must be at least 6 characters.');
      return;
    }

    // Pre-flight check against the public username registry. This used to be a query over
    // the `users` collection, which is not readable while signed out - so sign-up failed
    // with a permission error before an account was ever created.
    if (!(await isUsernameAvailable(trimmedUsername))) {
      Alert.alert('Username Taken', 'This username is already in use. Please choose another.');
      return;
    }

    let createdUser = null;
    try {
      const userCredential = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
      createdUser = userCredential.user;

      await new Promise((resolve) => {
        const unsub = auth.onAuthStateChanged((currentUser) => {
          if (currentUser) {
            unsub();
            resolve();
          }
        });
      });

      // Authoritative, race-free claim. Two people submitting the same name at the same
      // moment now have exactly one winner instead of two identical usernames.
      const claimed = await claimUsername(createdUser.uid, trimmedUsername);
      if (!claimed) {
        await deleteUser(createdUser).catch(() => {});
        Alert.alert('Username Taken', 'That username was just taken. Please choose another.');
        return;
      }

      await ensureUserProfile(createdUser, { username: trimmedUsername });

      navigation.reset({
        index: 0,
        routes: [{ name: 'Dashboard' }],
      });
    } catch (error) {
      if (error.code === 'auth/email-already-in-use') {
        Alert.alert('Account Exists', 'This account already exists. Please log in instead.');
      } else {
        Alert.alert('Sign Up Failed', error.message);
      }
    }
  };

  return (
    <TouchableWithoutFeedback onPress={Keyboard.dismiss} accessible={false}>
      <Screen>
        <View style={{ marginTop: 48, marginBottom: 40 }}>
          <Eyebrow>Get started</Eyebrow>
          <Text style={[t.typography.display, { color: t.colors.text, marginTop: 10 }]}>
            Create account
          </Text>
          <Text style={[t.typography.body, { color: t.colors.textMuted, marginTop: 8 }]}>
            A few seconds. Then you're on the road.
          </Text>
        </View>

        <Section>
          <Field label="Username" hint={`Up to ${MAX_USERNAME_LENGTH} characters.`}>
            <TextInput
              placeholder="yourhandle"
              placeholderTextColor={t.colors.textSubtle}
              style={inputStyle}
              value={username}
              onChangeText={setUsername}
              autoCapitalize="none"
            />
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
            />
          </Field>
          <Field label="Password" hint="At least 6 characters.">
            <TextInput
              placeholder="••••••••"
              placeholderTextColor={t.colors.textSubtle}
              style={inputStyle}
              value={password}
              onChangeText={setPassword}
              secureTextEntry
            />
          </Field>

          <Button title="Create Account" onPress={handleSignUp} />
        </Section>

        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'center',
            alignItems: 'center',
            marginTop: 12,
          }}
        >
          <Text style={[t.typography.body, { color: t.colors.textMuted }]}>
            Already have one?
          </Text>
          <Text
            onPress={() => navigation.goBack()}
            style={[t.typography.bodyStrong, { color: t.colors.accent, marginLeft: 6 }]}
          >
            Log in
          </Text>
        </View>
      </Screen>
    </TouchableWithoutFeedback>
  );
}
