// PermissionBanners — inline recovery for the permissions the map needs, shown
// over the map instead of an alert that throws the user off the screen.
import React, { useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import { useTheme, Banner, IconButton } from '../../theme';
import { PERMISSION_COPY } from '../../hooks/usePermissions';

function Action({ label, color, onPress }) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [pressed && { opacity: 0.7 }]}
    >
      <Text style={[t.typography.caption, { color: color || t.colors.accent, fontWeight: '700' }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export function PermissionBanners({ permissions }) {
  const t = useTheme();
  const [notifDismissed, setNotifDismissed] = useState(false);
  if (!permissions?.loaded) return null;

  const items = [];
  const { location, background, notifications } = permissions;

  if (location === 'denied' || location === 'unavailable') {
    items.push({
      key: 'location',
      tone: 'danger',
      title: 'Location sharing is off',
      body: PERMISSION_COPY.location.body,
      actionLabel: 'Open Settings',
      actionColor: t.colors.danger,
      onAction: permissions.openSettings,
    });
  } else if (location === 'undetermined') {
    items.push({
      key: 'location',
      tone: 'info',
      title: 'Show your location',
      body: PERMISSION_COPY.location.body,
      actionLabel: 'Allow',
      onAction: permissions.requestLocation,
    });
  } else if (background !== 'granted' && background !== 'unavailable') {
    items.push({
      key: 'background',
      tone: 'info',
      title: 'Your location updates only while RoadWise is open',
      body: PERMISSION_COPY.background.body,
      actionLabel: 'Fix',
      onAction: permissions.canAskLocation === false ? permissions.openSettings : permissions.requestBackground,
    });
  }

  if (notifications === 'denied' && !notifDismissed) {
    items.push({
      key: 'notifications',
      tone: 'info',
      title: 'Emergency alerts are off',
      body: PERMISSION_COPY.notifications.body,
      actionLabel: permissions.canAskNotifications === false ? 'Fix' : 'Allow',
      onAction:
        permissions.canAskNotifications === false ? permissions.openSettings : permissions.requestNotifications,
      onDismiss: () => setNotifDismissed(true),
    });
  }

  if (!items.length) return null;

  return (
    <>
      {items.map((item) => (
        <Banner
          key={item.key}
          tone={item.tone}
          title={item.title}
          body={item.body}
          right={
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Action label={item.actionLabel} color={item.actionColor} onPress={item.onAction} />
              {!!item.onDismiss && (
                <IconButton icon="close" tone="ghost" size={28} label="Dismiss" onPress={item.onDismiss} />
              )}
            </View>
          }
        />
      ))}
    </>
  );
}

export default PermissionBanners;
