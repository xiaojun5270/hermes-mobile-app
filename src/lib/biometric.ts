// src/lib/biometric.ts — Face ID (device-passcode fallback) right before a secure value is sent.
import * as LocalAuthentication from 'expo-local-authentication';

export type BiometricOutcome = { ok: true } | { ok: false; reason: 'cancelled' | 'unavailable' | 'failed' };

const CANCELLED = new Set(['user_cancel', 'app_cancel', 'system_cancel']);
const UNAVAILABLE = new Set(['passcode_not_set', 'not_enrolled', 'not_available']);

export async function confirmWithBiometrics(promptMessage: string): Promise<BiometricOutcome> {
  try {
    const res = await LocalAuthentication.authenticateAsync({ promptMessage, cancelLabel: '取消', disableDeviceFallback: false });
    if (res.success) return { ok: true };
    if (CANCELLED.has(res.error)) return { ok: false, reason: 'cancelled' };
    if (UNAVAILABLE.has(res.error)) return { ok: false, reason: 'unavailable' };
    return { ok: false, reason: 'failed' };
  } catch {
    return { ok: false, reason: 'failed' };
  }
}
