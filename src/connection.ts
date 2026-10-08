// src/connection.ts
import * as SecureStore from 'expo-secure-store';
import { CookieJar } from './api/cookieJar';
import { AuthError, RestClient } from './api/restClient';
import {
  ConnectionMode,
  StoredConnectionV2,
  migrateStoredConnection,
} from './lib/stored-connection';
import { resetConnectorState } from './connector-state';

const STORE_KEY = 'hermes-connection';

/** Message surfaced when a device pairing dies (revoked / RT expired / reuse
 * detected). There are no replayable credentials in device mode — the only
 * recovery is `hermes mobile pair` + scanning a fresh QR. */
export const REPAIR_MESSAGE =
  '此设备的配对已撤销或过期，请在网关运行 `hermes mobile pair` 后重新配对。';

let jar = new CookieJar();
let rest: RestClient | null = null;

// In-memory copy of the persisted blob: the jar's onChange hook updates
// `cookies` here and flushes the whole blob to SecureStore. Writes are
// serialized on a promise chain so a burst of rotations can't interleave.
let saved: StoredConnectionV2 | null = null;
let persistChain: Promise<void> = Promise.resolve();

function persistSaved(): Promise<void> {
  const snapshot = saved ? JSON.stringify(saved) : null;
  persistChain = persistChain
    .then(() =>
      snapshot === null
        ? SecureStore.deleteItemAsync(STORE_KEY)
        : SecureStore.setItemAsync(STORE_KEY, snapshot),
    )
    .catch(() => {}); // persistence is best-effort; next change retries
  return persistChain;
}

/** Resolve once all queued SecureStore writes have flushed. The RestClient
 * awaits this after a response rotates the refresh token, so the new RT is on
 * disk before the call resolves — an app suspension can't then strand us on the
 * rotated-out token (which the gateway treats as reuse). Never rejects. */
function flushCookiePersist(): Promise<void> {
  return persistChain;
}

/** Adopt a jar + blob as the live connection. The onChange hook persists the
 * jar after EVERY response that changed it — mandatory because refresh tokens
 * rotate server-side and replaying a stale persisted RT revokes the device. */
function activate(newJar: CookieJar, blob: StoredConnectionV2): void {
  jar.onChange(null);
  jar = newJar;
  saved = blob;
  jar.onChange((cookies) => {
    if (!saved) return;
    saved = { ...saved, cookies };
    void persistSaved();
  });
  // Connector state ("reload pending", a sign-in request) belongs to one gateway. A silent
  // re-login to the same address keeps it; a different address starts clean.
  if (rest?.baseUrl !== blob.baseUrl) resetConnectorState();
  rest = new RestClient(blob.baseUrl, jar, undefined, flushCookiePersist);
}

export function getRest(): RestClient {
  if (!rest) throw new Error('尚未连接，请返回连接页面。');
  return rest;
}

/** Connect with basic-auth credentials (password mode). */
export async function connect(baseUrl: string, username: string, password: string): Promise<void> {
  const cleanUrl = baseUrl.replace(/\/+$/, '');
  activate(new CookieJar(), {
    version: 2,
    baseUrl: cleanUrl,
    mode: 'password',
    username,
    password,
    cookies: {},
  });
  await getRest().login(username, password); // jar hook persisted the cookies
  await persistSaved();
}

/** Connect with a scanned pairing payload (device mode).
 *
 * Seeds the jar with the bare `hermes_session_rt` cookie; the gateway's auth
 * middleware sees an RT-only request, calls the mobile-device provider's
 * refresh, and Set-Cookies a fresh AT + rotated RT (docs/contracts/pairing.md).
 * The listSessions probe both validates the pairing and performs that first
 * rotation. AuthError here means the RT was already dead (revoked/expired). */
export async function connectWithDevice(baseUrl: string, rt: string, deviceId: string): Promise<void> {
  const cleanUrl = baseUrl.replace(/\/+$/, '');
  const seeded = { hermes_session_rt: rt };
  activate(CookieJar.fromJSON(seeded), {
    version: 2,
    baseUrl: cleanUrl,
    mode: 'device',
    deviceId,
    cookies: seeded,
  });
  // Persist BEFORE the probe: the probe rotates the RT, and the rotated jar
  // must land in an existing blob (the onChange hook fires mid-request).
  await persistSaved();
  try {
    await getRest().listSessions();
  } catch (e) {
    if (e instanceof AuthError) throw new AuthError(REPAIR_MESSAGE);
    throw e;
  }
  await persistSaved();
}

/** Restore a saved connection. Returns false if none saved (or unreadable).
 * Password mode re-logs-in when the stored cookies are dead; device mode has
 * nothing to replay, so a dead RT surfaces as AuthError(REPAIR_MESSAGE). */
export async function restore(): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(STORE_KEY);
  if (!raw) return false;
  let blob: StoredConnectionV2;
  try {
    blob = migrateStoredConnection(raw); // v1 password blobs migrate transparently
  } catch {
    return false;
  }
  activate(CookieJar.fromJSON(blob.cookies), blob);
  try {
    await getRest().listSessions(); // probe; ingests any rotated cookies
  } catch (e) {
    if (blob.mode === 'device') {
      // No credentials to replay. A 401 after the middleware's refresh
      // attempt means the device is revoked/expired → re-pair.
      if (e instanceof AuthError) throw new AuthError(REPAIR_MESSAGE);
      throw e; // network blip — keep the stored pairing intact
    }
    await getRest().login(blob.username ?? '', blob.password ?? ''); // cookies dead → fresh login
  }
  await persistSaved();
  return true;
}

/** Silent re-auth after an in-flight AuthError. Password mode replays the
 * stored credentials; device mode has nothing to replay (the RT already rode
 * along in the jar and the middleware's refresh still 401'd → revoked). */
async function reloginFromStore(): Promise<boolean> {
  if (!rest || !saved) return false;
  if (saved.mode === 'device') return false;
  try {
    await rest.login(saved.username ?? '', saved.password ?? '');
  } catch {
    return false;
  }
  await persistSaved();
  return true;
}

/** Run an authed call; on session expiry, silently re-login once and retry.
 * Rethrows AuthError when re-auth is impossible — password changed, or the
 * device pairing was revoked (device mode gets a re-pair message). Callers
 * route back to the Connect screen on that. */
export async function withAuthRetry<T>(fn: (r: RestClient) => Promise<T>): Promise<T> {
  const r = getRest();
  try {
    return await fn(r);
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    if (!(await reloginFromStore())) {
      if (saved?.mode === 'device') throw new AuthError(REPAIR_MESSAGE);
      throw e;
    }
    return fn(getRest());
  }
}

/** Saved connection details for display (settings screen).
 * `username` is '' in device mode (kept non-optional for the M1 settings
 * screen; the integrator switches on `mode` to render device rows instead). */
export async function connectionInfo(): Promise<{
  baseUrl: string;
  username: string;
  mode: ConnectionMode;
  deviceId?: string;
} | null> {
  const blob = saved ?? (await loadStored());
  if (!blob) return null;
  return {
    baseUrl: blob.baseUrl,
    username: blob.username ?? '',
    mode: blob.mode,
    deviceId: blob.deviceId,
  };
}

/** 'password' | 'device' for the saved connection, or null when none.
 * Exported for the settings integrator. */
export async function getConnectionMode(): Promise<ConnectionMode | null> {
  return (await connectionInfo())?.mode ?? null;
}

/** Paired device id (device mode only), or null. Exported for the settings
 * integrator and for push-token registration in M3. */
export async function getDeviceId(): Promise<string | null> {
  return (await connectionInfo())?.deviceId ?? null;
}

async function loadStored(): Promise<StoredConnectionV2 | null> {
  const raw = await SecureStore.getItemAsync(STORE_KEY);
  if (!raw) return null;
  try {
    return migrateStoredConnection(raw);
  } catch {
    return null;
  }
}

export async function disconnect(): Promise<void> {
  jar.onChange(null); // detach before clearing — don't resurrect the blob
  saved = null;
  await persistSaved(); // deletes the stored blob
  jar.clear();
  rest = null;
  resetConnectorState(); // "connectors changed, reload pending" belongs to the gateway just left
}

/** Mint a fresh single-use ticket and return the ws URL to dial (tickets live
 * 30s — always mint immediately before connecting). */
export async function mintGatewayUrl(): Promise<string> {
  const { ticket } = await withAuthRetry((r) => r.wsTicket());
  return getRest().wsUrl(ticket);
}
