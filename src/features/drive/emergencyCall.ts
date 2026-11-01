// Placing a call from the driving screen's emergency panel: the number goes to the phone's own call
// screen as a `tel:` link. iOS then asks "Call …?" and Android opens its dialer with the number in;
// neither step can be skipped. `canOpenURL` is never asked (it would need `tel` declared in the
// app's config); a failure to open reads as "didn't start", and nothing here throws.
import { Linking } from 'react-native';

import { telUrl } from '@/features/emergency/model';

export interface DialPort {
  openURL(url: string): Promise<unknown>;
}

export const defaultDialPort: DialPort = { openURL: (url) => Linking.openURL(url) };

/** Hands `phone` to the phone's call screen; false when it could not be opened. */
export async function placeCall(phone: string, port: DialPort = defaultDialPort): Promise<boolean> {
  try {
    await port.openURL(telUrl(phone));
    return true;
  } catch {
    return false;
  }
}

/** A number as people read it: US numbers grouped, "(555) 123-4567" or "+1 (555) 123-4567"; others as stored. */
export function displayPhone(phone: string): string {
  const us = /^(\+1)?(\d{3})(\d{3})(\d{4})$/.exec(phone);
  if (us === null) return phone;
  const local = `(${us[2]}) ${us[3]}-${us[4]}`;
  return us[1] === undefined ? local : `+1 ${local}`;
}
