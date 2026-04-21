import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  Modal,
  TextInput,
  ScrollView,
  StyleSheet,
  Alert,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { auth } from '../utils/firebase';
import { saveTrustedContacts, getTrustedContacts } from '../utils/firestore';
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

export default function SafetySettings() {
  const [contacts, setContacts] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [newContact, setNewContact] = useState({ name: '', phone: '' });
  const t = useTheme();
  const inputStyle = useInputStyle();

  const uid = auth.currentUser?.uid;

  const formatPhoneNumber = (value) => {
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
  };

  useEffect(() => {
    if (!uid) return;
    (async () => {
      const list = await getTrustedContacts(uid);
      setContacts(list);
    })();
  }, [uid]);

  useEffect(() => {
    if (showModal) setNewContact({ name: '', phone: '' });
  }, [showModal]);

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
    const existingContact = contacts.find(
      (c) => c.phone.replace(/\D/g, '') === digitsOnlyPhone
    );
    if (existingContact) {
      Alert.alert('Duplicate', `This number is already saved as "${existingContact.name || 'Unnamed'}".`);
      return;
    }
    const updated = [...contacts, newContact];
    setContacts(updated);
    await saveTrustedContacts(uid, updated);
    setNewContact({ name: '', phone: '' });
    setShowModal(false);
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
      <ScrollView showsVerticalScrollIndicator={false}>
        <ScreenHeader
          align="right"
          eyebrow="Settings · Safety"
          title="Safety"
          subtitle="Handle your safety preferences."
        />

        <Section label="Trusted Contacts">
          <Card padded={false}>
            {contacts.length === 0 ? (
              <View
                style={{
                  paddingVertical: 28,
                  paddingHorizontal: 20,
                  alignItems: 'center',
                }}
              >
                <View
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 24,
                    backgroundColor: t.colors.accentFaint,
                    alignItems: 'center',
                    justifyContent: 'center',
                    marginBottom: 12,
                  }}
                >
                  <Ionicons name="people-outline" size={22} color={t.colors.accent} />
                </View>
                <Text
                  style={[
                    t.typography.subheading,
                    { color: t.colors.text, marginBottom: 4 },
                  ]}
                >
                  No trusted contacts yet
                </Text>
                <Text
                  style={[
                    t.typography.caption,
                    { color: t.colors.textMuted, textAlign: 'center', maxWidth: 260 },
                  ]}
                >
                  Add someone who should hear from you if you have an emergency on the road.
                </Text>
              </View>
            ) : (
              <FlatList
                data={contacts}
                keyExtractor={(_, i) => i.toString()}
                scrollEnabled={false}
                renderItem={({ item, index }) => (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      paddingVertical: 14,
                      paddingHorizontal: 18,
                      borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
                      borderTopColor: t.colors.divider,
                    }}
                  >
                    <View
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 18,
                        backgroundColor: t.colors.accentFaint,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginRight: 12,
                      }}
                    >
                      <Text style={{ color: t.colors.accent, fontWeight: '700' }}>
                        {(item.name || '?')[0].toUpperCase()}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[t.typography.bodyStrong, { color: t.colors.text }]}>
                        {item.name || 'Unnamed'}
                      </Text>
                      <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>
                        {formatPhoneNumber(item.phone)}
                      </Text>
                    </View>
                    <Pressable
                      onPress={() => removeContact(index)}
                      hitSlop={10}
                      style={{ padding: 6 }}
                    >
                      <Ionicons name="trash-outline" size={20} color={t.colors.danger} />
                    </Pressable>
                  </View>
                )}
              />
            )}
          </Card>

          <View style={{ height: 12 }} />
          <Button
            title="Add Trusted Contact"
            onPress={() => setShowModal(true)}
            icon={<Ionicons name="add" size={18} color={t.colors.accentText} />}
          />
        </Section>
      </ScrollView>

      <Modal
        animationType="fade"
        transparent
        visible={showModal}
        onRequestClose={() => setShowModal(false)}
      >
        <View
          style={{
            flex: 1,
            justifyContent: 'flex-start',
            alignItems: 'center',
            backgroundColor: 'rgba(0,0,0,0.55)',
            padding: 24,
            paddingTop: 120
          }}
        >
          <Card style={{ width: '100%', maxWidth: 420 }}>
            <Text style={[t.typography.heading, { color: t.colors.text, marginBottom: 6 }]}>
              Add contact
            </Text>
            <Text
              style={[
                t.typography.caption,
                { color: t.colors.textMuted, marginBottom: 20 },
              ]}
            >
              They'll be reachable for RoadWise emergency alerts.
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
                <Button
                  title="Cancel"
                  variant="ghost"
                  onPress={() => setShowModal(false)}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button title="Save" onPress={handleAddContact} />
              </View>
            </View>
          </Card>
        </View>
      </Modal>
    </Screen>
  );
}
