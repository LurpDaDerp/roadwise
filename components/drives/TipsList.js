// TipsList — the rule-based improvement tips (utils/driveScore#getDriveTips) and
// the AI feedback tips, rendered with one shared row style.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card, useTheme } from '../../theme';

export function TipRow({ icon = 'bulb-outline', title, body, first = false }) {
  const t = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        paddingVertical: 14,
        paddingHorizontal: 18,
        borderTopWidth: first ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: t.colors.divider,
      }}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 15,
          backgroundColor: t.colors.accentFaint,
          alignItems: 'center',
          justifyContent: 'center',
          marginRight: 12,
        }}
      >
        <Ionicons name={icon} size={16} color={t.colors.accent} />
      </View>
      <View style={{ flex: 1 }}>
        {!!title && (
          <Text style={[t.typography.bodyStrong, { color: t.colors.text }]}>{title}</Text>
        )}
        {!!body && (
          <Text
            style={[
              t.typography.body,
              { color: title ? t.colors.textMuted : t.colors.text, marginTop: title ? 3 : 0, lineHeight: 21 },
            ]}
          >
            {body}
          </Text>
        )}
      </View>
    </View>
  );
}

// `tips` accepts either { icon, title, body } objects (getDriveTips) or plain
// strings (the AI feedback response).
export function TipsList({ tips = [], icon = 'bulb-outline', card = true, style }) {
  const list = Array.isArray(tips) ? tips.filter(Boolean) : [];
  if (list.length === 0) return null;

  const rows = list.map((tip, i) =>
    typeof tip === 'string' ? (
      <TipRow key={i} icon={icon} body={tip} first={i === 0} />
    ) : (
      <TipRow key={i} icon={tip.icon || icon} title={tip.title} body={tip.body} first={i === 0} />
    )
  );

  if (!card) return <View style={style}>{rows}</View>;
  return (
    <Card padded={false} style={style}>
      {rows}
    </Card>
  );
}

export default TipsList;
