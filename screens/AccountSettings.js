// AccountSettings — profile photo, username, account facts, drive-history wipe
// and sign-out. Profile values come from the live AuthContext subscription.
import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  Alert,
  ActivityIndicator,
  TextInput,
  ScrollView,
  Image,
  Pressable,
  StyleSheet,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { signOut } from 'firebase/auth';
import { doc, getDoc, setDoc, collection, query, where, getDocs } from 'firebase/firestore';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { auth, db } from '../utils/firebase';
import { supabase } from '../utils/supabase';
import { clearUserDrives, getAllDriveMetrics } from '../utils/firestore';
import { useAuthContext } from '../context/AuthContext';
import { KEYS } from '../utils/storageKeys';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  Button,
  Field,
  ListRow,
  KeyValueRow,
  Skeleton,
  useTheme,
  useInputStyle,
} from '../theme';

export default function AccountSettings() {
  const t = useTheme();
  const inputStyle = useInputStyle();
  const { uid, user, username, points, photoURL, groupId, profileLoaded } = useAuthContext();

  const [uploadedPhoto, setUploadedPhoto] = useState(null);
  const [loadingImage, setLoadingImage] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editedUsername, setEditedUsername] = useState('');
  const [saving, setSaving] = useState(false);
  const [groupName, setGroupName] = useState('None');
  const [driveCount, setDriveCount] = useState(null);
  const [clearing, setClearing] = useState(false);

  const photo = uploadedPhoto || photoURL;

  // Group name — one read, the id comes from the live profile.
  useEffect(() => {
    let cancelled = false;
    if (!groupId) {
      setGroupName('None');
      return undefined;
    }
    (async () => {
      try {
        const snap = await getDoc(doc(db, 'groups', groupId));
        if (!cancelled) setGroupName((snap.exists() && snap.data().groupName) || 'Unknown');
      } catch {
        if (!cancelled) setGroupName('Unknown');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  // Drive count — used by the clear-history confirmation.
  useEffect(() => {
    let cancelled = false;
    if (!uid) return undefined;
    (async () => {
      const drives = await getAllDriveMetrics(uid);
      if (!cancelled) setDriveCount(Array.isArray(drives) ? drives.length : 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [uid]);

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
        setUploadedPhoto(publicURL);
        await AsyncStorage.setItem(KEYS.cachedProfileImage, publicURL);
        await setDoc(doc(db, 'users', uid), { photoURL: publicURL }, { merge: true });
      }
    } catch (error) {
      Alert.alert('Upload failed', error.message);
    } finally {
      setLoadingImage(false);
    }
  };

  const handleSaveUsername = async () => {
    const trimmed = editedUsername.trim();
    if (!trimmed) {
      Alert.alert('Username required', 'Username cannot be empty.');
      return;
    }
    setSaving(true);
    try {
      const snapshot = await getDocs(query(collection(db, 'users'), where('username', '==', trimmed)));
      if (snapshot.docs.some((d) => d.id !== uid)) {
        Alert.alert('Username taken', 'This username is already in use.');
        return;
      }
      await setDoc(doc(db, 'users', uid), { username: trimmed }, { merge: true });
      setIsEditing(false);
    } catch (error) {
      Alert.alert('Update failed', error.message);
    } finally {
      setSaving(false);
    }
  };

  const confirmClearDrives = () => {
    const n = driveCount ?? 0;
    if (!uid || n === 0) {
      Alert.alert('Nothing to clear', 'You have no saved drives yet.');
      return;
    }
    Alert.alert(
      'Clear drive history',
      `This deletes all ${n} drive${n === 1 ? '' : 's'}, along with their scores and statistics. Your points and streak are not affected.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () =>
            Alert.alert('Really delete?', 'This cannot be undone.', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Delete everything',
                style: 'destructive',
                onPress: async () => {
                  setClearing(true);
                  await clearUserDrives(uid);
                  setDriveCount(0);
                  setClearing(false);
                  Alert.alert('Drive history cleared');
                },
              },
            ]),
        },
      ]
    );
  };

  return (
    <Screen hasHeader>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: t.spacing[8] }}
      >
        <ScreenHeader
          eyebrow="Settings"
          title="Account"
          subtitle="Your profile and sign-in details."
        />

        <Section>
          <Card>
            <View style={{ alignItems: 'center', paddingVertical: 8 }}>
              {!profileLoaded ? (
                <Skeleton width={96} height={96} radius={48} />
              ) : (
                <Pressable
                  onPress={pickImage}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Change profile photo"
                >
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
                    {photo ? (
                      <Image key={photo} source={{ uri: photo }} style={{ width: 96, height: 96 }} />
                    ) : (
                      <Text style={{ fontSize: 34, fontWeight: '800', color: t.colors.accent }}>
                        {(username || user?.email || '?')[0].toUpperCase()}
                      </Text>
                    )}
                    {loadingImage && (
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
              )}
              <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 10 }]}>
                Tap to change photo
              </Text>
            </View>
          </Card>
        </Section>

        <Section label="Profile">
          <Card padded={false}>
            {!profileLoaded ? (
              <View style={{ padding: 18, gap: 14 }}>
                <Skeleton height={18} />
                <Skeleton height={18} width="70%" />
                <Skeleton height={18} width="50%" />
              </View>
            ) : (
              <>
                <ListRow
                  first
                  icon="person-outline"
                  title={username || 'No username'}
                  subtitle="Username"
                  right={
                    !isEditing ? (
                      <Pressable
                        onPress={() => {
                          setEditedUsername(username || '');
                          setIsEditing(true);
                        }}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="Edit username"
                        style={{ padding: 4 }}
                      >
                        <Ionicons name="pencil" size={16} color={t.colors.accent} />
                      </Pressable>
                    ) : null
                  }
                />
                {isEditing && (
                  <View style={{ paddingHorizontal: 18, paddingBottom: 16 }}>
                    <Field hint="3–30 characters, must be unique.">
                      <TextInput
                        style={inputStyle}
                        value={editedUsername}
                        onChangeText={setEditedUsername}
                        editable={!saving}
                        autoFocus
                        autoCapitalize="none"
                        maxLength={30}
                        placeholder="Enter username"
                        placeholderTextColor={t.colors.textSubtle}
                      />
                    </Field>
                    <View style={{ flexDirection: 'row', gap: 10 }}>
                      <View style={{ flex: 1 }}>
                        <Button
                          title="Cancel"
                          variant="ghost"
                          onPress={() => setIsEditing(false)}
                          disabled={saving}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Button title="Save" onPress={handleSaveUsername} loading={saving} />
                      </View>
                    </View>
                  </View>
                )}
                <KeyValueRow label="Email" value={user?.email || 'Not signed in'} />
                <KeyValueRow label="Family group" value={groupName} />
                <KeyValueRow label="Lifetime points" value={points} accent />
              </>
            )}
          </Card>
        </Section>

        <Section label="Data">
          <Card padded={false}>
            <ListRow
              first
              destructive
              icon="trash-outline"
              title="Clear drive history"
              subtitle={
                driveCount === null
                  ? 'Deletes every saved drive on this account.'
                  : `Deletes all ${driveCount} saved drive${driveCount === 1 ? '' : 's'}. Points and streak stay.`
              }
              onPress={confirmClearDrives}
              disabled={clearing}
              right={clearing ? <ActivityIndicator size="small" color={t.colors.danger} /> : null}
            />
          </Card>
        </Section>

        <Section label="Session">
          <Button
            title="Sign out"
            variant="danger"
            icon={<Ionicons name="log-out-outline" size={18} color="#fff" />}
            onPress={() => signOut(auth)}
          />
        </Section>
      </ScrollView>
    </Screen>
  );
}
