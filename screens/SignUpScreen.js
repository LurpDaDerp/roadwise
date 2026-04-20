import React, { useState } from 'react';
import { View, Text, TextInput, Alert, Keyboard, TouchableWithoutFeedback } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { auth, db } from '../utils/firebase';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { useNavigation } from '@react-navigation/native';
import { doc, setDoc } from 'firebase/firestore';
import { saveUserPoints } from '../utils/firestore';
import { query, where, getDocs, collection } from 'firebase/firestore';
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

    if (!trimmedUsername) {
      Alert.alert('Validation Error', 'Username cannot be empty.');
      return;
    }
    if (trimmedUsername.length > 16) {
      Alert.alert('Username Too Long!', 'Username cannot be longer than 16 characters.');
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

    try {
      const q = query(collection(db, 'users'), where('username', '==', trimmedUsername));
      const querySnapshot = await getDocs(q);

      if (!querySnapshot.empty) {
        Alert.alert('Username Taken', 'This username is already in use. Please choose another.');
        return;
      }

      const userCredential = await createUserWithEmailAndPassword(auth, trimmedEmail, password);
      const uid = userCredential.user.uid;

      await new Promise((resolve) => {
        const unsub = auth.onAuthStateChanged((currentUser) => {
          if (currentUser) {
            unsub();
            resolve();
          }
        });
      });

      await setDoc(doc(db, 'users', uid), {
        username: trimmedUsername,
        points: 0,
        drivingStreak: 0,
        photoURL: null,
        groupId: null,
      });

      await setDoc(doc(db, 'userinfo', uid), {
        email: trimmedEmail,
        createdAt: new Date(),
      });

      await saveUserPoints(uid, 0);
      await AsyncStorage.setItem('totalPoints', '0');

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
          <Field label="Username" hint="Up to 16 characters.">
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
