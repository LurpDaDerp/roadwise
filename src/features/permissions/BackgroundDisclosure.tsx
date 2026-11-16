/**
 * Google Play's prominent disclosure for background location, shown on Android right before every
 * "Allow all the time" request (`backgroundDisclosureCopy`). A sheet over the screen that asked: what
 * is collected, that it is collected when the app is closed or not in use, and what for, with
 * Continue (then the request) and Not now (nothing is asked). Closing it any other way (Android back,
 * the scrim, a drag) is Not now. iOS never shows it: iPhone explains Always in its own prompt.
 *
 * `useBackgroundDisclosure()` gives a screen `ask()`, which shows the sheet and resolves with the
 * driver's choice, and the `sheet` element to render. The permission adapter refuses the Android
 * request without it (`requestLocationAlways` with `disclosed`), so a path that skips it asks nothing.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { View } from 'react-native';

import { Button, Sheet, Text, useTheme } from '@/ui';

import { backgroundDisclosureCopy as copy } from './copy';

export function BackgroundDisclosureSheet({ visible, onContinue, onNotNow }: { visible: boolean; onContinue: () => void; onNotNow: () => void }) {
  const th = useTheme();
  return (
    <Sheet
      visible={visible}
      onClose={onNotNow}
      title={copy.title}
      hideClose
      scroll
      testID="background-disclosure"
      footer={
        <View style={{ gap: th.space.sm }}>
          <Button label={copy.continue} onPress={onContinue} testID="background-disclosure-continue" />
          <Button label={copy.notNow} variant="ghost" onPress={onNotNow} testID="background-disclosure-not-now" />
        </View>
      }
    >
      <Text variant="body" testID="background-disclosure-body">
        {copy.body}
      </Text>
      <Text variant="body">{copy.uses}</Text>
      <Text variant="callout" tone="muted">
        {copy.next}
      </Text>
    </Sheet>
  );
}

export interface BackgroundDisclosure {
  /** Shows the disclosure; true once the driver chose Continue, false for Not now (or the screen going away). */
  ask(): Promise<boolean>;
  /** Render it once in the screen that asks. */
  sheet: ReactElement;
}

export function useBackgroundDisclosure(): BackgroundDisclosure {
  const [visible, setVisible] = useState(false);
  const pending = useRef<((choice: boolean) => void) | null>(null);

  const settle = useCallback((choice: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setVisible(false);
    resolve?.(choice);
  }, []);

  const ask = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        // A second ask while one shows answers the first as Not now: one sheet, one choice.
        pending.current?.(false);
        pending.current = resolve;
        setVisible(true);
      }),
    []
  );

  // A screen that goes away mid-question has asked nothing.
  useEffect(
    () => () => {
      pending.current?.(false);
      pending.current = null;
    },
    []
  );

  const sheet = <BackgroundDisclosureSheet visible={visible} onContinue={() => settle(true)} onNotNow={() => settle(false)} />;
  return { ask, sheet };
}
