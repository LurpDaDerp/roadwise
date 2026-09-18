// SafetySettings — the trusted contacts shown by the SOS button during a drive.
import React, { useEffect, useState } from 'react';
import { View, Text, Pressable, TextInput, ScrollView, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { saveTrustedContacts, getTrustedContacts } from '../utils/firestore';
import { useAuthContext } from '../context/AuthContext';
import {
  Screen,
  Section,
  Card,
  ScreenHeader,
  Button,
  Banner,
  Field,
  ListRow,
  EmptyState,
  Sheet,
  Skeleton,
  useTheme,
  useInputStyle,
} from '../theme';

function formatPhoneNumber(value) {
  if (!value) return value;
  const cleaned = value.replace(/\D/g, '');
  const match = cleaned.match(/^(\d{0,3})(\d{0,3})(\d{0,4})$/);
  if (!match) return value;
  let formatted = '';
  if (match[1]) formatted = '(' + match[1];
  if (match[1]?.length === 3) formatted += ')-';
  if (match[2]) formatted += match[2];
  if (match[2]?.length === 3) formatted += '-';
  if (match[3]) formatted += match[3];
  return formatted;
}

export default function SafetySettings() {
  const t = useTheme();
  const inputStyle = useInputStyle();
  const { uid } = useAuthContext();

  const [contacts, setContacts] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showSheet, setShowSheet] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', phone: '' });

  useEffect(() => {
    let cancelled = false;
    if (!uid) {
      setLoaded(true);
      return undefined;
    }
    (async () => {
      const list = await getTrustedContacts(uid);
      if (!cancelled) {
        setContacts(Array.isArray(list) ? list : []);
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uid]);

  const openSheet = () => {
    setNewContact({ name: '', phone: '' });
    setShowSheet(true);
  };

  const handleAddContact = async () => {
    if (!newContact.name || !newContact.phone) {
      Alert.alert('Incomplete', 'Please fill in both name and phone number.');
      return;
    }
    const digitsOnlyPhone = newContact.phone.replace(/\D/g, '');
    if (digitsOnlyPhone.length !== 10) {
      Alert.alert('Invalid phone', 'Please enter a valid 10-digit phone number.');
      return;
    }
    const existing = contacts.find((c) => c.phone.replace(/\D/g, '') === digitsOnlyPhone);
    if (existing) {
      Alert.alert('Duplicate', `This number is already saved as "${existing.name || 'Unnamed'}".`);
      return;
    }
    const updated = [...contacts, newContact];
    setContacts(updated);
    await saveTrustedContacts(uid, updated);
    setNewContact({ name: '', phone: '' });
    setShowSheet(false);
  };

  const removeContact = (index) => {
    const contact = contacts[index];
    Alert.alert(
      'Delete contact',
      `Remove "${contact.name || 'Unnamed'}" from trusted contacts?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            const updated = contacts.filter((_, i) => i !== index);
            setContacts(updated);
            await saveTrustedContacts(uid, updated);
          },
        },
      ],
      { cancelable: true }
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
          title="Safety"
          subtitle="Who to reach if something happens on the road."
        />

        <Section>
          <Banner
            tone="info"
            icon="alert-circle-outline"
            body="Trusted contacts appear behind the SOS button on the drive screen, so you can call or text them without leaving the drive."
          />
        </Section>

        <Section label="Trusted contacts">
          <Card padded={false}>
            {!loaded ? (
              <View style={{ padding: 18, gap: 14 }}>
                <Skeleton height={18} />
                <Skeleton height={18} width="60%" />
              </View>
            ) : contacts.length === 0 ? (
              <EmptyState
                icon="people-outline"
                title="No trusted contacts yet"
                body="Add someone who should hear from you if you have an emergency on the road."
              />
            ) : (
              contacts.map((item, index) => (
                <ListRow
                  key={`${item.phone}-${index}`}
                  first={index === 0}
                  title={item.name || 'Unnamed'}
                  subtitle={formatPhoneNumber(item.phone)}
                  icon={
                    <Text style={{ color: t.colors.accent, fontWeight: '700' }}>
                      {(item.name || '?')[0].toUpperCase()}
                    </Text>
                  }
                  right={
                    <Pressable
                      onPress={() => removeContact(index)}
                      hitSlop={10}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ${item.name || 'contact'}`}
                      style={{ padding: 6 }}
                    >
                      <Ionicons name="trash-outline" size={20} color={t.colors.danger} />
                    </Pressable>
                  }
                />
              ))
            )}
          </Card>

          <View style={{ height: 12 }} />
          <Button
            title="Add trusted contact"
            onPress={openSheet}
            icon={<Ionicons name="add" size={18} color={t.colors.accentText} />}
          />
        </Section>
      </ScrollView>

      <Sheet
        visible={showSheet}
        onClose={() => setShowSheet(false)}
        eyebrow="Safety"
        title="Add contact"
      >
        <Text style={[t.typography.caption, { color: t.colors.textMuted, marginBottom: 18 }]}>
          They will be reachable from the SOS button during a drive.
        </Text>

        <Field label="Name">
          <TextInput
            style={inputStyle}
            placeholder="Name"
            placeholderTextColor={t.colors.textSubtle}
            value={newContact.name}
            onChangeText={(text) => setNewContact({ ...newContact, name: text })}
          />
        </Field>
        <Field label="Phone">
          <TextInput
            style={inputStyle}
            placeholder="(555) 555-5555"
            placeholderTextColor={t.colors.textSubtle}
            keyboardType="phone-pad"
            value={newContact.phone}
            onChangeText={(text) => setNewContact({ ...newContact, phone: text })}
          />
        </Field>

        <View style={{ flexDirection: 'row', gap: 12, marginTop: 8 }}>
          <View style={{ flex: 1 }}>
            <Button title="Cancel" variant="ghost" onPress={() => setShowSheet(false)} />
          </View>
          <View style={{ flex: 1 }}>
            <Button title="Save" onPress={handleAddContact} />
          </View>
        </View>
      </Sheet>
    </Screen>
  );
}
