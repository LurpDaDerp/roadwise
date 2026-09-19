// useStartDrive — the one-tap drive start. There is no prep screen: tapping Start (or the
// auto-start countdown finishing) goes straight into the drive.
//
//   * Location is the only hard requirement. It is asked for here only if it has never been
//     answered (onboarding normally asks); a refusal shows one alert with a Settings shortcut.
//   * The camera is only needed when driver monitoring is on. It is asked for once, on a tapped
//     start, and never blocks the drive: without it the drive simply runs unmonitored.
//   * An automatic start never shows a permission prompt (the driver is already moving).
import { useCallback, useRef, useState } from 'react';
import { Alert, Linking } from 'react-native';
import * as Location from 'expo-location';
import { useNavigation } from '@react-navigation/native';

import { useSettings } from '../context/SettingsContext';
import { MONITORING_AVAILABLE } from '../monitoring/settings';
import { cameraPermission } from './usePermissions';
import { snoozeAutoStart } from './useAutoStartDrive';

export function useStartDrive() {
  const navigation = useNavigation();
  const { settings } = useSettings();
  const busyRef = useRef(false);
  const [starting, setStarting] = useState(false);

  const monitoringWanted = MONITORING_AVAILABLE && !!settings.monitoringEnabled;
  const driverSide = settings.monitoringDriverSide;

  const startDrive = useCallback(
    async ({ auto = false } = {}) => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setStarting(true);
      try {
        let location = await Location.getForegroundPermissionsAsync();
        if (location.status !== 'granted' && !auto && location.canAskAgain !== false) {
          location = await Location.requestForegroundPermissionsAsync();
        }
        if (location.status !== 'granted') {
          if (!auto) {
            Alert.alert(
              'Location is off',
              'RoadWise needs your location to read your speed and the speed limit during a drive.',
              [
                { text: 'Not now', style: 'cancel' },
                { text: 'Open Settings', onPress: () => Linking.openSettings().catch(() => {}) },
              ]
            );
          }
          return false;
        }

        let monitoringEnabled = false;
        if (monitoringWanted) {
          try {
            let camera = await cameraPermission();
            if (camera.status === 'undetermined' && camera.canAskAgain && !auto) {
              camera = await cameraPermission({ request: true });
            }
            monitoringEnabled = camera.status === 'granted';
          } catch {
            monitoringEnabled = false;
          }
        }

        // A drive that just started must not be offered again by auto-start the moment Home
        // regains focus after it ends (the car may still be rolling).
        snoozeAutoStart();
        navigation.navigate('Drive', { monitoringEnabled, driverSide, autoStarted: auto });
        return true;
      } catch {
        return false;
      } finally {
        busyRef.current = false;
        setStarting(false);
      }
    },
    [navigation, monitoringWanted, driverSide]
  );

  return { startDrive, starting };
}

export default useStartDrive;
