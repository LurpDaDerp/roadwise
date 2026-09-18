// MemberSheet — member detail: where they are, when that was, how fast they
// are moving, and the two actions that matter (locate, call).
import React, { useCallback, useEffect, useState } from 'react';
import { View, Text, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useTheme, Sheet, Card, Button, IconButton, KeyValueRow } from '../../theme';
import { relativeTime, formatSpeed, speedFromMps } from '../../utils/format';

export function MemberSheet({ visible, member, isMe, unit = 'mph', onClose, onLocate }) {
  const t = useTheme();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!visible) setCopied(false);
  }, [visible]);

  const copyAddress = useCallback(async () => {
    if (!member?.address) return;
    try {
      await Clipboard.setStringAsync(member.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      console.warn('Copy failed:', e);
    }
  }, [member?.address]);

  if (!member) return null;

  const where = member.displayName || member.address || 'Location unknown';
  const speed = Number(member.speed) || 0;

  return (
    <Sheet
      visible={!!visible}
      onClose={onClose}
      eyebrow="Member"
      title={`${member.name}${isMe ? ' (You)' : ''}`}
    >
      <View style={{ gap: 14 }}>
        <View>
          <Text style={[t.typography.micro, { color: t.colors.textMuted, marginBottom: 6 }]}>
            {copied ? 'Copied to clipboard' : 'Location'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={[t.typography.body, { color: t.colors.text, flex: 1 }]}>{where}</Text>
            {!!member.address && (
              <IconButton
                icon={copied ? 'checkmark' : 'copy-outline'}
                tone="accent"
                size={36}
                label="Copy address"
                onPress={copyAddress}
              />
            )}
          </View>
        </View>

        <Card padded={false}>
          <KeyValueRow
            first
            label="Last update"
            value={member.updatedAt ? relativeTime(member.updatedAt) : 'No update yet'}
          />
          <KeyValueRow label="Speed" value={formatSpeed(speedFromMps(speed, unit), unit)} />
          {!!member.emergency && <KeyValueRow label="Status" value="Emergency" tone="danger" />}
        </Card>

        {!!member.coords && (
          <Button
            title="Locate on map"
            icon={<Ionicons name="navigate" size={16} color={t.colors.accentText} />}
            onPress={() => {
              onClose();
              if (onLocate) onLocate(member);
            }}
          />
        )}

        {!!member.phone && (
          <Button
            variant="ghost"
            title="Call"
            icon={<Ionicons name="call-outline" size={16} color={t.colors.text} />}
            onPress={() => Linking.openURL(`tel:${member.phone}`).catch(() => {})}
          />
        )}

        <Button variant="ghost" title="Close" onPress={onClose} />
      </View>
    </Sheet>
  );
}

export default MemberSheet;
