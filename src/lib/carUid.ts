// A paired car's uid as stored drives hold it (`trips.car_uid`). Android 14 and later hide a
// Bluetooth address from an app without Nearby devices: it reads "XX:XX:XX:XX:AB:CD", only its last
// two bytes real. Native lists one uid per car and swaps the hidden form for the full address once
// it is readable (CarLinkRecord.kt's `CarUids.same`), but drives stored before that keep the hidden
// form. So a hidden address and a full one ending in the same two bytes are the same car here too.
// iPhone's uids (route port uids) never take either form, so on iPhone this is plain equality.

const ADDRESS = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
const HIDDEN = /^XX:XX:XX:XX:[0-9A-F]{2}:[0-9A-F]{2}$/;

/** The same car: the same uid, or Android's hidden form of an address and the full address ending in the same two bytes. */
export function sameCarUid(a: string, b: string): boolean {
  if (a === b) return true;
  const hidden = HIDDEN.test(a) ? a : HIDDEN.test(b) ? b : null;
  const full = ADDRESS.test(a) ? a : ADDRESS.test(b) ? b : null;
  return hidden !== null && full !== null && hidden.slice(-5) === full.slice(-5);
}
