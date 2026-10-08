/** Pure helpers for staging a picked photo as an `image.attach_bytes` RPC.
 *
 * Wire contract (docs/contracts/attachments.md): `prompt.submit` has no image
 * params — the client calls `image.attach_bytes` first with
 * `{session_id, content_base64, filename?}` and the next submit drains the
 * server-side queue. Max 25 MB decoded; allowed extensions
 * png/jpg/jpeg/gif/webp/bmp; without a filename the gateway sniffs the format
 * from magic bytes.
 */

/** Server-side decoded-size cap (`_ATTACH_BYTES_MAX_BYTES`, error 4018). */
export const MAX_ATTACH_BYTES = 25 * 1024 * 1024;

/** Extensions the gateway accepts in `filename` (error 4016 otherwise). */
const ALLOWED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
};

export interface PickedImage {
  /** Local uri for the thumbnail / sent-bubble preview. */
  uri: string;
  /** Raw base64 of the image bytes (no data: prefix needed by the contract). */
  base64: string;
  fileName?: string | null;
  mimeType?: string | null;
  width?: number;
  height?: number;
}

/** Decoded byte length of a base64 string (tolerates whitespace + padding). */
export function base64ByteLength(b64: string): number {
  const compact = b64.replace(/\s+/g, '');
  if (compact.length === 0) return 0;
  const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
  return Math.floor((compact.length * 3) / 4) - padding;
}

function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Pick a `filename` the gateway will accept, or undefined to let it sniff the
 * format from magic bytes (safer than sending e.g. photo.heic → error 4016).
 * Preference order: asset fileName, uri basename, mime type.
 */
export function attachFilename(img: {
  fileName?: string | null;
  uri?: string;
  mimeType?: string | null;
}): string | undefined {
  for (const candidate of [img.fileName, img.uri]) {
    if (!candidate) continue;
    // Basename, with any query string stripped (file.jpg?x=1 → file.jpg).
    const base = (candidate.split('/').pop() ?? candidate).split('?')[0];
    const ext = extensionOf(base);
    if (ext && ALLOWED_EXTENSIONS.has(ext)) return base;
  }
  if (img.mimeType) {
    const ext = MIME_TO_EXT[img.mimeType.toLowerCase()];
    if (ext) return `photo.${ext}`;
  }
  return undefined;
}

/**
 * Fit an image into the chat-bubble box (default max 240×220 pt) preserving
 * aspect ratio. Unknown/degenerate dimensions fall back to a 4:3 landscape.
 */
export function bubbleImageSize(
  width?: number,
  height?: number,
  maxW = 240,
  maxH = 220,
): { width: number; height: number } {
  let w = typeof width === 'number' && width > 0 ? width : 0;
  let h = typeof height === 'number' && height > 0 ? height : 0;
  if (!w || !h) {
    w = 4;
    h = 3;
  }
  const scale = Math.min(maxW / w, maxH / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

export interface AttachBytesParams {
  session_id: string;
  content_base64: string;
  filename?: string;
  [key: string]: unknown;
}

/**
 * Build the `image.attach_bytes` params for a staged photo.
 * Throws before hitting the wire if the decoded size exceeds the 25 MB cap
 * or the base64 payload is empty.
 */
export function buildAttachParams(sessionId: string, img: PickedImage): AttachBytesParams {
  const bytes = base64ByteLength(img.base64);
  if (bytes === 0) throw new Error('图片为空，请重新选择。');
  if (bytes > MAX_ATTACH_BYTES) {
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    throw new Error(`图片大小为 ${mb} MB，网关最多接收 25 MB。`);
  }
  const filename = attachFilename(img);
  return {
    session_id: sessionId,
    content_base64: img.base64,
    ...(filename ? { filename } : {}),
  };
}
