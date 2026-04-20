import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  TextInput,
  ScrollView,
  Image,
  Pressable,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { auth, db } from '../utils/firebase';
import { signOut, onAuthStateChanged } from 'firebase/auth';
import { useNavigation } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getUserPoints, saveUserPoints } from '../utils/firestore';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { Ionicons } from '@expo/vector-icons';
import { query, where, getDocs, collection } from 'firebase/firestore';
import { supabase } from '../utils/supabase';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  Button,
  Field,
  useTheme,
  useInputStyle,
} from '../theme';

export default function AccountSettings({ route }) {
  const navigation = useNavigation();
  const t = useTheme();
  const inputStyle = useInputStyle();

  const [user, setUser] = useState(null);
  const [username, setUsername] = useState(null);
  const [editedUsername, setEditedUsername] = useState('');
  const [points, setPoints] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadingImage, setLoadingImage] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [photoURL, setPhotoURL] = useState('noImage');
  const [groupName, setGroupName] = useState('None');

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        const uid = currentUser.uid;
        const cachedImage = await AsyncStorage.getItem('cachedProfileImage');
        if (cachedImage) setPhotoURL(cachedImage);

        try {
          const userPoints = await getUserPoints(uid);
          setPoints(userPoints);

          const userDocRef = doc(db, 'users', uid);
          const userDocSnap = await getDoc(userDocRef);

          if (userDocSnap.exists()) {
            const data = userDocSnap.data();
            setUsername(data.username || 'N/A');
            setPhotoURL(data.photoURL || 'noImage');

            if (data.groupId) {
              const groupDocRef = doc(db, 'groups', data.groupId);
              const groupDocSnap = await getDoc(groupDocRef);
              if (groupDocSnap.exists()) {
                setGroupName(groupDocSnap.data().groupName || 'Unknown');
              } else {
                setGroupName('Unknown');
              }
            } else {
              setGroupName('None');
            }
          }
        } catch (err) {
          console.error(err);
          setPoints(0);
          setUsername('N/A');
          setGroupName('None');
        }
      }
      setLoading(false);
    });

    return unsubscribe;
  }, []);

  const pickImage = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });

      setLoadingImage(true);

      if (!result.canceled && result.assets.length > 0) {
        const uri = result.assets[0].uri;
        const uid = user.uid;
        const filename = `${uid}/profilePic.jpg`;

        const response = await fetch(uri);
        const buffer = await response.arrayBuffer();

        await supabase.storage.from('profile-pictures').remove([filename]);

        const { error } = await supabase.storage
          .from('profile-pictures')
          .upload(filename, buffer, {
            cacheControl: '3600',
            upsert: true,
            contentType: 'image/jpeg',
          });
        if (error) throw error;

        const { data: urlData, error: urlError } = supabase.storage
          .from('profile-pictures')
          .getPublicUrl(filename);
        if (urlError) throw urlError;

        const publicURL = urlData.publicUrl + '?t=' + new Date().getTime();
        setPhotoURL(publicURL);
        await AsyncStorage.setItem('cachedProfileImage', publicURL);

        const userDocRef = doc(db, 'users', uid);
        await setDoc(userDocRef, { photoURL: publicURL }, { merge: true });
      }
    } catch (error) {
      Alert.alert('Upload Failed', error.message);
    } finally {
      setLoadingImage(false);
    }
  };

  const handleSaveUsername = async () => {
    if (!editedUsername.trim()) {
      Alert.alert('Validation Error', 'Username cannot be empty.');
      return;
    }
    setSaving(true);
    try {
      const uid = user.uid;
      const trimmed = editedUsername.trim();
      const q = query(collection(db, 'users'), where('username', '==', trimmed));
      const querySnapshot = await getDocs(q);
      const taken = querySnapshot.docs.some((d) => d.id !== uid);
      if (taken) {
        Alert.alert('Username Taken', 'This username is already in use.');
        setSaving(false);
        return;
      }
      const userDocRef = doc(db, 'users', uid);
      await setDoc(userDocRef, { username: trimmed }, { merge: true });
      setUsername(trimmed);
      setIsEditing(false);
    } catch (error) {
      Alert.alert('Update Failed', error.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Screen>
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ActivityIndicator size="small" color={t.colors.accent} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScrollView showsVerticalScrollIndicator={false}>
        <ScreenHeader
          eyebrow="Settings · Account"
          title="Account"
          subtitle="Your profile and sign-in details."
        />

        <Section>
          <Card>
            <View style={{ alignItems: 'center', paddingVertical: 8 }}>
              <Pressable onPress={pickImage} hitSlop={8}>
                <View
                  style={{
                    width: 96,
                    height: 96,
                    borderRadius: 48,
                    backgroundColor: t.colors.accentFaint,
                    alignItems: 'center',
                    justifyContent: 'center',
                    overflow: 'hidden',
                    borderWidth: 2,
                    borderColor: t.colors.accent,
                  }}
                >
                  {photoURL !== 'noImage' ? (
                    <Image
                      key={photoURL}
                      source={{ uri: photoURL }}
                      style={{ width: 96, height: 96 }}
                      onLoadEnd={() => setLoadingImage(false)}
                    />
                  ) : (
                    <Text
                      style={{
                        fontSize: 34,
                        fontWeight: '800',
                        color: t.colors.accent,
                      }}
                    >
                      {username ? username[0].toUpperCase() : '?'}
                    </Text>
                  )}
                  {loadingImage && photoURL !== 'noImage' && (
                    <View
                      style={{
                        ...StyleSheet.absoluteFillObject,
                        backgroundColor: 'rgba(0,0,0,0.45)',
                        justifyContent: 'center',
                        alignItems: 'center',
                      }}
                    >
                      <ActivityIndicator size="small" color="#fff" />
                    </View>
                  )}
                </View>
              </Pressable>
              <Text
                style={[
                  t.typography.caption,
                  { color: t.colors.textMuted, marginTop: 10 },
                ]}
              >
                Tap to change photo
              </Text>
            </View>
          </Card>
        </Section>

        <Section label="Profile">
          <Card padded={false}>
            <Row
              label="Username"
              value={username ?? 'N/A'}
              t={t}
              right={
                !isEditing && (
                  <Pressable
                    onPress={() => {
                      setEditedUsername(username === 'N/A' ? '' : username);
                      setIsEditing(true);
                    }}
                    hitSlop={10}
                    style={{ padding: 4 }}
                  >
                    <Ionicons name="pencil" size={16} color={t.colors.accent} />
                  </Pressable>
                )
              }
              first
            >
              {isEditing && (
                <View style={{ marginTop: 10 }}>
                  <Field>
                    <TextInput
                      style={inputStyle}
                      value={editedUsername}
                      onChangeText={setEditedUsername}
                      editable={!saving}
                      autoFocus
                      maxLength={30}
                      placeholder="Enter username"
                      placeholderTextColor={t.colors.textSubtle}
                    />
                  </Field>
                  <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
                    <View style={{ flex: 1 }}>
                      <Button
                        title="Cancel"
                        variant="ghost"
                        onPress={() => setIsEditing(false)}
                        disabled={saving}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Button
                        title={saving ? 'Saving…' : 'Save'}
                        onPress={handleSaveUsername}
                        disabled={saving}
                      />
                    </View>
                  </View>
                </View>
              )}
            </Row>
            <Row label="Email" value={user?.email ?? 'Not logged in'} t={t} />
            <Row label="Current group" value={groupName} t={t} />
            <Row label="Total points" value={String(points ?? 0)} t={t} accent />
          </Card>
        </Section>

        <Section label="Session">
          <Button
            title="Switch account"
            variant="ghost"
            icon={<Ionicons name="swap-horizontal" size={18} color={t.colors.text} />}
            onPress={async () => {
              await signOut(auth);
              if (navigation) navigation.navigate('Dashboard');
            }}
          />
          <View style={{ height: 10 }} />
          <Button
            title="Sign out"
            variant="danger"
            icon={<Ionicons name="log-out-outline" size={18} color="#fff" />}
            onPress={async () => {
              const uid = user?.uid;
              if (uid) {
                const stored = await AsyncStorage.getItem('totalPoints');
                const totalPoints = stored ? parseFloat(stored) : 0;
                await saveUserPoints(uid, totalPoints);
              }
              await signOut(auth);
              if (navigation) navigation.navigate('Dashboard');
            }}
          />
        </Section>

        <View style={{ height: 24 }} />
      </ScrollView>
    </Screen>
  );
}

function Row({ label, value, t, right, accent, first, children }) {
  return (
    <View
      style={{
        paddingVertical: 14,
        paddingHorizontal: 18,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: t.colors.divider,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          <Text
            style={[
              t.typography.micro,
              {
                color: t.colors.textMuted,
                textTransform: 'uppercase',
                letterSpacing: 1.1,
              },
            ]}
          >
            {label}
          </Text>
          <Text
            style={[
              t.typography.bodyStrong,
              { color: accent ? t.colors.accent : t.colors.text, marginTop: 4 },
            ]}
          >
            {value}
          </Text>
        </View>
        {right}
      </View>
      {children}
    </View>
  );
}
