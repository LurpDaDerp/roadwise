// GroupHeader — the header of the family bottom sheet: group name, how many
// members, the invite code, a native share action and leaving the group.
import React, { useCallback } from 'react';
import { View, Text, Pressable, Share } from 'react-native';
import { useTheme, Eyebrow, IconButton } from '../../theme';
import { pluralize } from '../../utils/format';

export function GroupHeader({ name, code, memberCount = 0, onLeave }) {
  const t = useTheme();

  const shareCode = useCallback(async () => {
    if (!code) return;
    try {
      await Share.share({
        message: `Join my RoadWise family group${name ? ` "${name}"` : ''} so we can see each other on the road. Open RoadWise, go to Family and enter the code ${code}.`,
      });
    } catch (e) {
      console.warn('Share sheet failed:', e);
    }
  }, [code, name]);

  return (
    <View style={{ marginTop: 4, marginBottom: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
        <View style={{ flex: 1, paddingRight: 12 }}>
          <Eyebrow style={{ marginBottom: 6 }}>Family group</Eyebrow>
          <Text style={[t.typography.title, { color: t.colors.text }]} numberOfLines={2}>
            {name || 'Your group'}
          </Text>
          <Text style={[t.typography.caption, { color: t.colors.textMuted, marginTop: 4 }]}>
            {pluralize(memberCount, 'member')}
            {code ? ` · Code ${code}` : ''}
          </Text>
        </View>

        <View style={{ alignItems: 'center', gap: 6 }}>
          <IconButton
            icon="share-outline"
            tone="accent"
            label="Share the group code"
            onPress={shareCode}
            disabled={!code}
          />
          <Pressable
            onPress={onLeave}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Leave this group"
            style={({ pressed }) => [pressed && { opacity: 0.7 }]}
          >
            <Text style={[t.typography.caption, { color: t.colors.danger, fontWeight: '700' }]}>Leave</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

export default GroupHeader;
