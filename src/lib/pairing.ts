// src/lib/pairing.ts
/** Parsing for `hermes mobile pair` QR payloads (docs/contracts/pairing.md).
 *
 * The QR (and the CLI's manual-paste fallback) encodes compact JSON:
 *   {"url":"http://100.x.y.z:9119","rt":"<refresh token>","device_id":"<hex>"}
 * `url` is arbitrary http(s) — `--url` overrides the detected default, so we
 * must not assume host shape or port. `rt` is the live device credential.
 */

export interface PairingPayload {
  /** Gateway base URL, normalised: no trailing slash. */
  url: string;
  /** Live refresh token — the whole device credential. Handle like a password. */
  rt: string;
  deviceId: string;
}

export class PairingParseError extends Error {}

/** Parse + validate a scanned/pasted pairing payload.
 * Throws PairingParseError with a user-facing message on anything invalid. */
export function parsePairingPayload(text: string): PairingPayload {
  const trimmed = (text ?? '').trim();
  if (!trimmed) throw new PairingParseError('配对码为空。');

  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    throw new PairingParseError('这不是 Hermes 配对码，请使用 `hermes mobile pair` 生成的 JSON。');
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new PairingParseError('这不是 Hermes 配对码，请使用 `hermes mobile pair` 生成的 JSON。');
  }

  const obj = data as Record<string, unknown>;
  const url = obj.url;
  const rt = obj.rt;
  const deviceId = obj.device_id;
  if (typeof url !== 'string' || typeof rt !== 'string' || typeof deviceId !== 'string') {
    throw new PairingParseError('配对码缺少 url、rt 或 device_id。');
  }
  if (!rt.trim()) throw new PairingParseError('配对码中的刷新令牌为空。');
  if (!deviceId.trim()) throw new PairingParseError('配对码中的设备标识为空。');
  if (!/^https?:\/\/.+/i.test(url.trim())) {
    throw new PairingParseError('配对码的网关地址必须使用 HTTP 或 HTTPS。');
  }

  return {
    url: url.trim().replace(/\/+$/, ''),
    rt: rt.trim(),
    deviceId: deviceId.trim(),
  };
}

/** Display host (host:port) of a pairing URL, for the confirm step. */
export function pairingHost(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url);
  return m ? m[1] : url;
}
