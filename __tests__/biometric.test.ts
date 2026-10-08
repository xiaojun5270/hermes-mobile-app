// __tests__/biometric.test.ts
jest.mock('expo-local-authentication', () => ({ authenticateAsync: jest.fn() }));
import * as LocalAuthentication from 'expo-local-authentication';
import { confirmWithBiometrics } from '../src/lib/biometric';

const auth = LocalAuthentication.authenticateAsync as jest.Mock;

test('passes the reason and keeps the device-passcode fallback', async () => {
  auth.mockResolvedValueOnce({ success: true });
  expect(await confirmWithBiometrics('Send KEY 给 Hermes')).toEqual({ ok: true });
  expect(auth).toHaveBeenCalledWith({ promptMessage: 'Send KEY 给 Hermes', cancelLabel: '取消', disableDeviceFallback: false });
});
test.each([
  ['user_cancel', 'cancelled'], ['app_cancel', 'cancelled'], ['system_cancel', 'cancelled'],
  ['passcode_not_set', 'unavailable'], ['not_enrolled', 'unavailable'], ['not_available', 'unavailable'],
  ['authentication_failed', 'failed'], ['lockout', 'failed'], ['unknown', 'failed'],
])('%s → %s', async (error, reason) => {
  auth.mockResolvedValueOnce({ success: false, error });
  expect(await confirmWithBiometrics('x')).toEqual({ ok: false, reason });
});
test('a thrown native error is a failure, never a send', async () => {
  auth.mockRejectedValueOnce(new Error('native'));
  expect(await confirmWithBiometrics('x')).toEqual({ ok: false, reason: 'failed' });
});
