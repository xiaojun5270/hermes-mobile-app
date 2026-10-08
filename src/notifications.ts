// src/notifications.ts — Expo push registration + tap handling.
// Pure logic (staleness, routes, payload shapes) lives in src/lib/push.ts;
// this module owns the Expo/OS surface (docs/contracts/push.md).
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Alert, AppState, Platform } from 'react-native';
import { getConnectionMode, getDeviceId, withAuthRetry } from '@/connection';
import {
  PUSH_TOKEN_ROUTE,
  canJoinInFlight,
  isRegistrationFresh,
  parsePushRegistration,
  routeForPushData,
  shouldSuppressForeground,
} from '@/lib/push';

const REG_STORE_KEY = 'hermes-push-registration';
export const EAS_INIT_NOTE = '需运行 eas init 配置推送通知';

/** Settings-facing registration state (read with getPushStatus). */
export interface PushStatus {
  state: 'idle' | 'registered' | 'denied' | 'no-project-id' | 'unavailable' | 'error';
  /** One-line note for the settings screen, when there is something to say. */
  note?: string;
  /** Whether the OS permission prompt can still be shown. `true` when the
   *  user hasn't seen the OS dialog yet (idle, error); `false` when they
   *  denied at the OS level and must go to Settings to re-enable. Undefined
   *  for states where the concept doesn't apply (registered, unavailable). */
  canAskAgain?: boolean;
}

let status: PushStatus = { state: 'idle' };

export function getPushStatus(): PushStatus {
  return status;
}

/** Re-attempt push registration with permission prompt. Returns a copy of
 *  the resulting status (callers get a snapshot, not a mutable reference). */
export async function requestPushPermission(): Promise<PushStatus> {
  // Return the status produced by THIS run (maybeRegisterPush resolves with it),
  // not a re-read of the module-level `status`, which a coalesced run could own.
  return { ...(await maybeRegisterPush({ softAsk: true })) };
}

/** EAS project id, required by getExpoPushTokenAsync in dev-client builds.
 * Written into app.json's extra.eas by `eas init` — absent until then. */
function easProjectId(): string | null {
  const fromExtra = (Constants.expoConfig?.extra as Record<string, any> | undefined)?.eas?.projectId;
  const fromEas = (Constants as any).easConfig?.projectId;
  const id = fromExtra ?? fromEas;
  return typeof id === 'string' && id ? id : null;
}

/** Our own pre-permission prompt: the OS dialog is one-shot, so never burn it
 * without the user already having said yes once (soft-ask pattern). */
function softAskPermission(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      '开启通知？',
      '应用关闭时，Hermes 可在智能体发来消息后通知你。',
      [
        { text: '暂不开启', style: 'cancel', onPress: () => resolve(false) },
        { text: '开启', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/** Register (or refresh) this device's Expo push token with the gateway.
 *
 * Call with `softAsk: true` right after a device-mode pairing (may prompt),
 * and `softAsk: false` on app start (never prompts; only re-registers when
 * permission is already granted and the stored registration is stale —
 * >7 days, different token, or different pairing). No-ops in password mode,
 * on web/simulators, and when no EAS projectId is configured (in that case
 * settings shows "Run eas init to enable push"; we never run eas ourselves).
 * Failures are swallowed: push is best-effort, the next launch retries.
 *
 * The work itself lives in registerPushImpl and mutates the module-level
 * `status`; it always runs through maybeRegisterPush below, which serializes
 * concurrent callers and resolves with the status the run produced. */
async function registerPushImpl(opts: { softAsk: boolean }): Promise<void> {
  try {
    if (Platform.OS === 'web' || !Device.isDevice) {
      status = { state: 'unavailable', note: '推送通知需要真实设备' };
      return;
    }
    if ((await getConnectionMode()) !== 'device') {
      // Password mode has no device identity → no push-token route access.
      status = { state: 'unavailable', note: '请先扫码配对设备以使用推送通知' };
      return;
    }
    const deviceId = await getDeviceId();
    if (!deviceId) {
      status = { state: 'unavailable', note: '请先扫码配对设备以使用推送通知' };
      return;
    }
    const projectId = easProjectId();
    if (!projectId) {
      status = { state: 'no-project-id', note: EAS_INIT_NOTE };
      return;
    }

    let perms = await Notifications.getPermissionsAsync();
    if (!perms.granted) {
      if (!opts.softAsk) {
        // App-start path: never prompt, just skip until the next pairing.
        status = perms.canAskAgain
          ? { state: 'idle', canAskAgain: true }
          : { state: 'denied', note: '系统设置中已关闭通知', canAskAgain: false };
        return;
      }
      if (!perms.canAskAgain) {
        status = { state: 'denied', note: '系统设置中已关闭通知', canAskAgain: false };
        return;
      }
      if (!(await softAskPermission())) {
        status = { state: 'idle', canAskAgain: true };
        return;
      }
      perms = await Notifications.requestPermissionsAsync();
      if (!perms.granted) {
        status = { state: 'denied', note: '系统设置中已关闭通知', canAskAgain: false };
        return;
      }
    }

    if (process.env.EXPO_OS === 'android') {
      // Android 8+ shows nothing without a channel — create it before any token work.
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Hermes',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250],
      });
    }

    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
    const stored = parsePushRegistration(await SecureStore.getItemAsync(REG_STORE_KEY));
    if (isRegistrationFresh(stored, token, deviceId, Date.now())) {
      status = { state: 'registered' };
      return;
    }
    await withAuthRetry((r) => r.post<{ ok: boolean }>(PUSH_TOKEN_ROUTE, { token }));
    await SecureStore.setItemAsync(
      REG_STORE_KEY,
      JSON.stringify({ token, registeredAt: Date.now(), deviceId }),
    );
    status = { state: 'registered' };
  } catch (e) {
    // Best-effort by design (mailbox is the source of truth) — log and move on.
    // On Android, getExpoPushTokenAsync throws here until FCM is configured
    // (google-services.json + EAS FCM V1 credentials — see READY.md "Android
    // push setup"), so Android push stays off without breaking login.
    console.warn('push registration skipped:', e instanceof Error ? e.message : e);
    status = { state: 'error', note: '通知注册失败，下次启动时将重试', canAskAgain: true };
  }
}

let inFlight: Promise<PushStatus> | null = null;
let inFlightSoftAsk = false;

export async function maybeRegisterPush(opts: { softAsk: boolean }): Promise<PushStatus> {
  // Serialize concurrent callers, but coalesce only when the in-flight run is at
  // least as strong as this request (canJoinInFlight). A soft-ask tap must never
  // join an app-start `softAsk:false` run that never prompts — otherwise the OS
  // dialog is silently skipped. A soft-ask arriving mid app-start waits the
  // weaker run out, then starts a fresh prompting run. Resolves with the status
  // THIS run produced, so requestPushPermission never reads a foreign snapshot.
  if (inFlight && canJoinInFlight(inFlightSoftAsk, opts.softAsk)) return inFlight;
  if (inFlight) await inFlight.catch(() => {});
  inFlightSoftAsk = opts.softAsk;
  inFlight = (async () => {
    await registerPushImpl(opts);
    return status;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = null;
    inFlightSoftAsk = false;
  }
}

// Response identifiers we've already routed, so the cold-start path
// (getColdStartRoute) and the live listener never double-navigate for the
// same tap. Module-level: both share it across the app's lifetime.
const handledResponseIds = new Set<string>();

/** Install the foreground handler (banner, no sound/badge) and the tap
 * listener. Pushes for claimed sessions carry `data.session_id` (the stored
 * route id); `onTap` receives the raw `data` so the caller can deep-link via
 * routeForPushData. Cron/legacy pushes carry no id → caller opens the chat
 * home. Cold-start taps (app was killed) are handled by getColdStartRoute,
 * sequenced after the connect-screen restore. Returns an unsubscribe. */
export function setupNotificationHandling(onTap: (data: unknown) => void): () => void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const data = notification.request.content.data;
      if (shouldSuppressForeground(data, AppState.currentState)) {
        return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };
      }
      return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false };
    },
  });
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    const id = response.notification.request.identifier;
    if (handledResponseIds.has(id)) return; // already routed by cold-start (or a prior fire)
    handledResponseIds.add(id);
    onTap(response.notification.request.content.data);
  });
  return () => sub.remove();
}

/** Route for the notification that cold-started the app (app was killed when
 * the user tapped), or null if the app wasn't launched from a notification.
 * Marks the response handled so the live listener won't re-route it. Call
 * AFTER the connect-screen restore so its replace() doesn't clobber the target. */
export async function getColdStartRoute(): Promise<string | null> {
  const response = await Notifications.getLastNotificationResponseAsync();
  if (!response) return null;
  handledResponseIds.add(response.notification.request.identifier);
  return routeForPushData(response.notification.request.content.data);
}
