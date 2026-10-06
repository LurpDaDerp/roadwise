import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, View } from 'react-native';

import { TopBar } from '@/features/settings/parts';
import { parseAddLink, profileHref } from '@/features/social/links';
import { Banner, Button, Screen, Text, useTheme } from '@/ui';

import { friendsCopy as copy } from './copy';

/** How long "not a RoadWise code" stays up before the same code may say it again. */
const REJECT_MS = 2_500;

/**
 * `/friends/scan`: the camera is asked for only here, when this screen opens. A code is read only
 * if it is exactly `roadwise://add/<username>`; anything else (a URL, another app's code) is
 * refused with one line and never opened.
 */
export function ScanScreen() {
  const th = useTheme();
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [rejected, setRejected] = useState(false);
  const done = useRef(false);
  const lastReject = useRef(0);

  // Ask once on arrival, only if the phone still can.
  useEffect(() => {
    if (permission && !permission.granted && permission.canAskAgain && permission.status === 'undetermined') {
      void requestPermission();
    }
  }, [permission, requestPermission]);

  const onScan = (result: BarcodeScanningResult) => {
    if (done.current) return;
    const username = parseAddLink(result.data);
    if (username) {
      done.current = true;
      router.replace(profileHref(username));
      return;
    }
    const now = Date.now();
    if (now - lastReject.current > REJECT_MS) {
      lastReject.current = now;
      setRejected(true);
    }
  };

  let body;
  if (!permission) {
    body = null;
  } else if (!permission.granted) {
    body = (
      <View style={{ gap: th.space.md }}>
        <Text variant="body">{permission.canAskAgain ? copy.cameraWhy : copy.cameraDenied}</Text>
        {permission.canAskAgain ? (
          <Button label={copy.allowCamera} icon="camera" onPress={() => void requestPermission()} testID="scan-allow" />
        ) : (
          <Button label={copy.openSettings} variant="secondary" onPress={() => void Linking.openSettings()} testID="scan-settings" />
        )}
      </View>
    );
  } else {
    body = (
      <View style={{ gap: th.space.md }}>
        <Text variant="body" tone="muted">
          {copy.scanBody}
        </Text>
        <View
          style={{ aspectRatio: 1, borderRadius: th.radius.card, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: '#000000' }}
          accessibilityLabel={copy.scanBody}
        >
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onScan}
            testID="scan-camera"
          />
        </View>
        {rejected ? <Banner tone="warning" message={copy.notOurs} testID="scan-rejected" /> : null}
      </View>
    );
  }

  return (
    <Screen scroll testID="scan-screen">
      <TopBar title={copy.scanTitle} />
      {body}
    </Screen>
  );
}
