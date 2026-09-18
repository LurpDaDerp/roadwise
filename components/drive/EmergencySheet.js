// EmergencySheet — SOS actions: call emergency services, notify the family
// group, call a trusted contact. Big targets, one tap each.
import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, Sheet } from '../../theme';

function BigAction({ icon, label, sub, tone, onPress, t }) {
  const tones = {
    danger: { bg: t.colors.danger, fg: '#fff' },
    accent: { bg: t.colors.accent, fg: t.colors.accentText },
    soft: { bg: t.colors.accentFaint, fg: t.colors.accent },
    ghost: { bg: 'transparent', fg: t.colors.text },
  };
  const c = tones[tone] || tones.soft;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          backgroundColor: c.bg,
          borderWidth: tone === 'ghost' ? StyleSheet.hairlineWidth : 0,
          borderColor: t.colors.borderStrong,
          borderRadius: t.radius.md,
          paddingVertical: 16,
          paddingHorizontal: 16,
          opacity: pressed ? 0.85 : 1,
        },
      ]}
    >
      <Ionicons name={icon} size={24} color={c.fg} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: c.fg, fontSize: 17, fontWeight: '800' }}>{label}</Text>
        {!!sub && <Text style={{ color: c.fg, opacity: 0.8, fontSize: 13, fontWeight: '600', marginTop: 1 }}>{sub}</Text>}
      </View>
      <Ionicons name="chevron-forward" size={18} color={c.fg} />
    </Pressable>
  );
}

export function EmergencySheet({ visible, onClose, contacts = [], onCall911, onNotifyGroup, onCallContact, isEmergencyActive, onCancelEmergency, hasGroup }) {
  const t = useTheme();
  return (
    <Sheet visible={visible} onClose={onClose} eyebrow="Emergency" title="Need help?" align="bottom">
      <View style={{ gap: 10 }}>
        <BigAction t={t} tone="danger" icon="call" label="Call 911" sub="Emergency services" onPress={onCall911} />
        {isEmergencyActive ? (
          <BigAction t={t} tone="soft" icon="checkmark-circle" label="I'm safe now" sub="Clear the alert sent to your group" onPress={onCancelEmergency} />
        ) : (
          <BigAction
            t={t}
            tone="accent"
            icon="people"
            label="Alert my family group"
            sub={hasGroup ? 'Shares your live location with them' : 'Join a group in the Family tab first'}
            onPress={onNotifyGroup}
          />
        )}
        {contacts.map((c, i) => (
          <BigAction
            key={`${c.phone}-${i}`}
            t={t}
            tone="soft"
            icon="call-outline"
            label={`Call ${c.name || 'contact'}`}
            sub={c.phone}
            onPress={() => onCallContact(c.phone)}
          />
        ))}
        <BigAction t={t} tone="ghost" icon="close" label="Cancel" onPress={onClose} />
      </View>
    </Sheet>
  );
}

export default EmergencySheet;
