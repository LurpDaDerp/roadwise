// EmergencyBanner — sits over the map whenever any member of the group, the
// signed-in user included, has raised an emergency.
import React from 'react';
import { View, Text, Pressable } from 'react-native';
import { useTheme, Banner } from '../../theme';

function Action({ label, onPress, solid }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        {
          paddingHorizontal: 12,
          paddingVertical: 7,
          borderRadius: t.radius.pill,
          backgroundColor: solid ? t.colors.danger : 'transparent',
          borderWidth: solid ? 0 : 1,
          borderColor: t.colors.danger,
          opacity: pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text style={{ color: solid ? '#ffffff' : t.colors.danger, fontSize: 12, fontWeight: '700' }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function EmergencyBanner({ members = [], uid, onLocate, onClearMine, style }) {
  const active = members.filter((m) => m && m.emergency);
  if (!active.length) return null;

  const mine = active.find((m) => m.uid === uid) || null;
  const subject = active.find((m) => m.uid !== uid) || mine;
  const isMine = subject && subject.uid === uid;

  const title = isMine ? 'You signalled an emergency' : `${subject.name} needs help`;
  const body =
    active.length > 1
      ? `${active.length} members need help`
      : subject.displayName || subject.address || 'Waiting for a location update';

  return (
    <Banner
      tone="danger"
      icon="alert-circle"
      title={title}
      body={body}
      style={style}
      right={
        <View style={{ gap: 6, alignItems: 'flex-end' }}>
          {!!subject.coords && <Action label="Locate" solid onPress={() => onLocate && onLocate(subject)} />}
          {!!mine && <Action label="I'm safe" onPress={onClearMine} />}
        </View>
      }
    />
  );
}

export default EmergencyBanner;
