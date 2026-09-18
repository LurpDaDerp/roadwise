// MonitoringSummaryCard — per-drive monitoring metrics for DriveSummary,
// DriveDetail and Insights. Accepts the `monitoring` block of a drive record.
import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card, Chip, useTheme, StatCell, StatDivider, ProgressBar } from '../../theme';
import { DROWSINESS_LABELS, alertCopy } from '../../monitoring/types';
import { totalAlerts } from '../../monitoring/summary';

export function MonitoringSummaryCard({ monitoring, compact = false, style }) {
  const t = useTheme();
  if (!monitoring) return null;
  if (!monitoring.enabled) {
    return (
      <Card style={style}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Ionicons name="videocam-off-outline" size={20} color={t.colors.textSubtle} />
          <Text style={[t.typography.caption, { color: t.colors.textMuted, flex: 1 }]}>
            Driver monitoring was off for this drive.
          </Text>
        </View>
      </Card>
    );
  }
  const counts = monitoring.alertCounts || {};
  const total = totalAlerts(monitoring);
  const eyesOff = Math.round(Number(monitoring.eyesOffRoadSeconds) || 0);
  const peak = Math.max(0, Math.min(3, Number(monitoring.drowsinessPeak) || 0));
  const quality = typeof monitoring.calibrationQuality === 'number' ? monitoring.calibrationQuality : null;
  const byType = Object.entries(monitoring.alertsByType || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, compact ? 3 : 6);

  return (
    <Card style={style}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Ionicons name="eye-outline" size={18} color={t.colors.accent} />
          <Text style={[t.typography.subheading, { color: t.colors.text }]}>Driver monitoring</Text>
        </View>
        <Chip
          label={total === 0 ? 'No alerts' : `${total} alert${total === 1 ? '' : 's'}`}
          tone={counts.critical > 0 ? 'danger' : counts.warning > 0 ? 'warning' : total > 0 ? 'info' : 'success'}
        />
      </View>
      <View style={{ flexDirection: 'row' }}>
        <StatCell label="Eyes off road" value={`${eyesOff}s`} size="sm" color={eyesOff >= 30 ? t.colors.danger : eyesOff >= 10 ? t.colors.warning : t.colors.text} />
        <StatDivider />
        <StatCell label="Warnings" value={String(counts.warning || 0)} size="sm" color={counts.warning > 0 ? t.colors.warning : t.colors.text} />
        <StatDivider />
        <StatCell label="Critical" value={String(counts.critical || 0)} size="sm" color={counts.critical > 0 ? t.colors.danger : t.colors.text} />
      </View>
      {!compact && (
        <View style={{ marginTop: 14, gap: 10 }}>
          <View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>Peak drowsiness</Text>
              <Text style={[t.typography.caption, { color: peak >= 2 ? t.colors.danger : t.colors.text, fontWeight: '700' }]}>
                {DROWSINESS_LABELS[peak]}
              </Text>
            </View>
            <ProgressBar value={peak / 3} tone={peak >= 2 ? 'danger' : peak === 1 ? 'warning' : 'accent'} height={6} />
          </View>
          {quality !== null && (
            <View>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                <Text style={[t.typography.caption, { color: t.colors.textMuted }]}>Calibration quality</Text>
                <Text style={[t.typography.caption, { color: t.colors.text, fontWeight: '700' }]}>{Math.round(quality * 100)}%</Text>
              </View>
              <ProgressBar value={quality} tone={quality < 0.5 ? 'warning' : 'accent'} height={6} />
            </View>
          )}
          {byType.length > 0 && (
            <View style={{ marginTop: 4 }}>
              {byType.map(([type, n], i) => (
                <View
                  key={type}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingVertical: 8,
                    borderTopWidth: i === 0 ? 0 : StyleSheet.hairlineWidth,
                    borderTopColor: t.colors.divider,
                    gap: 10,
                  }}
                >
                  <Ionicons name={alertCopy(type).icon} size={16} color={t.colors.textMuted} />
                  <Text style={[t.typography.caption, { color: t.colors.text, flex: 1 }]}>{alertCopy(type).title}</Text>
                  <Text style={[t.typography.caption, { color: t.colors.textMuted, fontWeight: '700' }]}>×{n}</Text>
                </View>
              ))}
            </View>
          )}
        </View>
      )}
    </Card>
  );
}

export default MonitoringSummaryCard;
