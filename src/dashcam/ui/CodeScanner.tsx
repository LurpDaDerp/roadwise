import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useEffect, useRef } from 'react';
import { View } from 'react-native';

import type { PermissionsAdapter } from '@/core/permissions';
import { defaultPermissionsAdapter } from '@/features/permissions/usePermissionHealth';
import { Button, Text, useTheme } from '@/ui';

import { dashpalCopy } from '../copy';

const copy = dashpalCopy.setup;

/**
 * The setup's camera step: QR codes only, the camera asked for when this opens (only if the phone
 * still can). Every code read goes to `onScanned`; the setup decides whether it is a DashPal code.
 * Denied: the line to allow it in Settings (the typed entry stays below). Nothing is recorded.
 */
export function CodeScanner({ onScanned, adapter }: { onScanned(text: string): void; adapter?: PermissionsAdapter }) {
  const th = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current || !permission || permission.granted || !permission.canAskAgain || permission.status !== 'undetermined') return;
    asked.current = true;
    void requestPermission();
  }, [permission, requestPermission]);

  if (!permission) return null;
  if (!permission.granted) {
    return (
      <View style={{ gap: th.space.sm }} testID="setup-camera-denied">
        <Text variant="body">{copy.cameraDenied}</Text>
        {permission.canAskAgain ? (
          <Button label={copy.allowCamera} icon="camera" variant="secondary" onPress={() => void requestPermission()} testID="setup-camera-allow" />
        ) : (
          <Button
            label={dashpalCopy.screen.fix.openSettings}
            variant="secondary"
            onPress={() => void (adapter ?? defaultPermissionsAdapter()).openAppSettings().catch(() => {})}
            testID="setup-camera-settings"
          />
        )}
      </View>
    );
  }
  return (
    <View style={{ gap: th.space.sm }}>
      <Text variant="headline">{copy.scan}</Text>
      <Text variant="callout" tone="muted">
        {copy.scanHelp}
      </Text>
      <View style={{ aspectRatio: 1, borderRadius: th.radius.card, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: '#000000' }} accessibilityLabel={copy.scan}>
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(r: BarcodeScanningResult) => onScanned(r.data)}
          testID="setup-camera"
        />
      </View>
    </View>
  );
}
