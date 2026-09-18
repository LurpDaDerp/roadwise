// MetricGroup — a titled card of label/value rows. Rows with a null or
// undefined value are dropped, so old drive records simply show fewer rows.
import React from 'react';
import { View, Text } from 'react-native';
import { Card, KeyValueRow, useTheme } from '../../theme';

export function MetricGroup({ title, rows = [], children, style }) {
  const t = useTheme();
  const visible = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && r.value !== null && r.value !== undefined && r.value !== ''
  );
  if (visible.length === 0 && !children) return null;

  return (
    <Card padded={false} style={style}>
      {!!title && (
        <View style={{ paddingHorizontal: 18, paddingTop: 16, paddingBottom: 4 }}>
          <Text style={[t.typography.subheading, { color: t.colors.text }]}>{title}</Text>
        </View>
      )}
      {visible.map((r, i) => (
        <KeyValueRow
          key={r.label}
          label={r.label}
          value={r.value}
          accent={r.accent}
          tone={r.tone}
          first={i === 0 && !title}
        />
      ))}
      {children}
    </Card>
  );
}

export default MetricGroup;
