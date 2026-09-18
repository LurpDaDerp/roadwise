// MemberRow — one family member in the bottom sheet: avatar, name, status
// chips, where they are and when that was last heard from.
import React from 'react';
import { View, Text } from 'react-native';
// expo-image, not RN Image: these are remote avatars, and only expo-image has a disk cache.
// With RN Image every mount of the list re-downloads every member's photo.
import { Image } from 'expo-image';
import { useTheme, Card, Chip, IconButton } from '../../theme';
import { relativeTime, formatSpeed, speedFromMps } from '../../utils/format';

// A member counts as driving above 10 m/s (about 22 mph), the threshold the
// original Family screen used.
const DRIVING_MPS = 10;

export const MemberRow = React.memo(function MemberRow({ member, isMe, unit = 'mph', onPress, onLocate }) {
  const t = useTheme();
  if (!member) return null;

  const speed = Number(member.speed) || 0;
  const driving = speed > DRIVING_MPS;
  const where = member.displayName || member.address || (member.coords ? 'Locating' : 'No location yet');
  const seen = member.updatedAt ? relativeTime(member.updatedAt) : null;
  const initial = (member.name || 'M').trim().charAt(0).toUpperCase();

  return (
    <Card padded={false} onPress={onPress} style={{ marginBottom: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 12 }}>
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 21,
            marginRight: 12,
            overflow: 'hidden',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: member.emergency ? t.colors.dangerFaint : t.colors.accentFaint,
          }}
        >
          {member.photoURL ? (
            <Image
              source={{ uri: member.photoURL }}
              style={{ width: '100%', height: '100%' }}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={member.uid}
              transition={0}
            />
          ) : (
            <Text style={{ color: member.emergency ? t.colors.danger : t.colors.accent, fontWeight: '700', fontSize: 16 }}>
              {initial}
            </Text>
          )}
        </View>

        <View style={{ flex: 1, paddingRight: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
            <Text style={[t.typography.bodyStrong, { color: t.colors.text }]} numberOfLines={1}>
              {member.name}
              {isMe ? ' (You)' : ''}
            </Text>
            {!!member.emergency && <Chip label="Emergency" tone="danger" icon="alert-circle" />}
            {driving && (
              <Chip
                label={`Driving · ${formatSpeed(speedFromMps(speed, unit), unit)}`}
                tone="accent"
                icon="car-sport"
              />
            )}
          </View>

          <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 3 }]} numberOfLines={1}>
            {where}
          </Text>
          {!!seen && (
            <Text style={[t.typography.caption, { color: t.colors.textSubtle, marginTop: 1 }]} numberOfLines={1}>
              {seen}
            </Text>
          )}
        </View>

        {!!member.coords && (
          <IconButton
            icon={member.emergency ? 'location-sharp' : 'location-outline'}
            tone={member.emergency ? 'danger' : 'accent'}
            size={36}
            label={`Locate ${member.name} on the map`}
            onPress={() => onLocate && onLocate(member)}
          />
        )}
      </View>
    </Card>
  );
});

export default MemberRow;
