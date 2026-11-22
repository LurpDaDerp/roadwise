// The JS side of Android's FLAG_SECURE on the Modal dialogs (`@drive-sense/secureDialogs`): the key
// and the hold go to DriveSense as asked, and a build without the function (iOS, Jest, an older
// Android build) or a native failure changes nothing and never rejects.
import { secureDialogs, setSecureDialogsModuleForTests } from '@drive-sense/secureDialogs';

afterEach(() => setSecureDialogsModuleForTests(undefined));

test('holds and lets go under the key given', async () => {
  const native = jest.fn(async (_key: string, _on: boolean) => {});
  setSecureDialogsModuleForTests({ secureDialogs: native });
  await secureDialogs('dashpal-aim-1', true);
  await secureDialogs('dashpal-aim-1', false);
  expect(native.mock.calls).toEqual([
    ['dashpal-aim-1', true],
    ['dashpal-aim-1', false],
  ]);
});

test('iPhone (the module has no such function), no module at all, or the real lookup in Jest: nothing, no rejection', async () => {
  setSecureDialogsModuleForTests({});
  await expect(secureDialogs('dashpal-aim-1', true)).resolves.toBeUndefined();
  setSecureDialogsModuleForTests(null);
  await expect(secureDialogs('dashpal-aim-1', true)).resolves.toBeUndefined();
  setSecureDialogsModuleForTests(undefined);
  await expect(secureDialogs('dashpal-aim-1', true)).resolves.toBeUndefined();
});

test('a native failure never rejects', async () => {
  setSecureDialogsModuleForTests({ secureDialogs: async () => Promise.reject(new Error('no activity')) });
  await expect(secureDialogs('dashpal-aim-1', true)).resolves.toBeUndefined();
});
