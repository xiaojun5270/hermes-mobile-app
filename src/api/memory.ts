// src/api/memory.ts
//
// Memory admin surface, per docs/contracts/memory.md.
//
// The dashboard core exposes exactly three memory operations: status,
// provider selection, and reset (file deletion) — no per-entry CRUD.
// Built-in memory is two markdown files on disk (MEMORY.md and USER.md
// under <HERMES_HOME>/memories/).
//
// Whole-file read/write IS available when the hermes-mobile plugin (>= the
// feat/memory-api build) is installed on the gateway: it mounts
// /api/plugins/mobile/memory/files (manifest name "mobile" — the dashboard
// mounts plugin routers at /api/plugins/<manifest name>). Those routes accept
// any authenticated dashboard session and never path-join the file name
// (fixed allowlist of MEMORY.md / USER.md). If the plugin is missing or too
// old the routes 404 and the app degrades to read-only sizes.
import { HttpError, type RestClient } from './restClient';

export interface MemoryProviderInfo {
  name: string;
  description: string;
  configured: boolean;
}

export interface MemoryStatus {
  /** "" = built-in markdown files; otherwise the active plugin provider name. */
  active: string;
  providers: MemoryProviderInfo[];
  /** Byte sizes of the built-in files; 0 = file absent. */
  builtin_files: { memory: number; user: number };
}

export type MemoryResetTarget = 'all' | 'memory' | 'user';

export interface MemoryResetResponse {
  ok: boolean;
  deleted: string[];
}

export interface MemoryProviderResponse {
  ok: boolean;
  active: string;
}

/** Sentinel sent to the server to select the built-in file backend. */
export const BUILT_IN_PROVIDER = '';

export function getMemoryStatus(r: RestClient): Promise<MemoryStatus> {
  return r.get<MemoryStatus>('/api/memory');
}

/** Switch the memory backend. `''` selects built-in files. 400 for unknown providers. */
export function setMemoryProvider(r: RestClient, provider: string): Promise<MemoryProviderResponse> {
  return r.put<MemoryProviderResponse>('/api/memory/provider', { provider });
}

/** Delete the built-in memory file(s). Irreversible — confirm with the user first. */
export function resetMemory(r: RestClient, target: MemoryResetTarget): Promise<MemoryResetResponse> {
  return r.post<MemoryResetResponse>('/api/memory/reset', { target });
}

/** Human label for a provider value as returned in `MemoryStatus.active`. */
export function providerLabel(provider: string): string {
  return provider === BUILT_IN_PROVIDER ? '内置文件' : provider;
}

/** "Empty" for absent files (size 0), else a compact human-readable size. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '暂无内容';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${trimDecimal(bytes / 1024)} KB`;
  return `${trimDecimal(bytes / (1024 * 1024))} MB`;
}

function trimDecimal(n: number): string {
  const fixed = n.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

// ---------------------------------------------------------------------------
// Whole-file editing via the hermes-mobile plugin (/api/plugins/mobile).
// ---------------------------------------------------------------------------

/** Route prefix for the plugin's memory-file CRUD (dashboard mounts the
 * plugin router at /api/plugins/<manifest name>, and the manifest name is
 * "mobile"). */
export const MEMORY_FILES_BASE = '/api/plugins/mobile/memory/files';

/** Server-side cap on the UTF-8 encoded PUT body (256 KiB → HTTP 413). */
export const MEMORY_FILE_MAX_BYTES = 256 * 1024;

/** The fixed server allowlist — anything else 404s. */
export const MEMORY_FILE_NAMES = ['MEMORY.md', 'USER.md'] as const;
export type MemoryFileName = (typeof MEMORY_FILE_NAMES)[number];

export interface MemoryFileInfo {
  name: string;
  /** Bytes on disk; 0 when absent. */
  size: number;
  /** Unix seconds (st_mtime, may be fractional); 0 when absent. */
  mtime: number;
  exists: boolean;
}

export interface MemoryFileListResponse {
  files: MemoryFileInfo[];
}

export interface MemoryFileContent {
  name: string;
  /** Whole file as UTF-8 text; "" for an allowlisted-but-missing file. */
  content: string;
}

export interface MemoryFileWriteResponse {
  ok: boolean;
  name: string;
  size: number;
}

export function listMemoryFiles(r: RestClient): Promise<MemoryFileListResponse> {
  return r.get<MemoryFileListResponse>(MEMORY_FILES_BASE);
}

export function readMemoryFile(r: RestClient, name: MemoryFileName): Promise<MemoryFileContent> {
  return r.get<MemoryFileContent>(`${MEMORY_FILES_BASE}/${encodeURIComponent(name)}`);
}

/** Atomic whole-file replace. 413 over the cap, 404 unknown name/old plugin. */
export function writeMemoryFile(
  r: RestClient,
  name: MemoryFileName,
  content: string,
): Promise<MemoryFileWriteResponse> {
  return r.put<MemoryFileWriteResponse>(`${MEMORY_FILES_BASE}/${encodeURIComponent(name)}`, { content });
}

/** Type guard: is this string one of the two editable file names? */
export function isMemoryFileName(name: unknown): name is MemoryFileName {
  return name === 'MEMORY.md' || name === 'USER.md';
}

/** Human label matching the admin screen's wording. */
export function memoryFileLabel(name: MemoryFileName): string {
  return name === 'MEMORY.md' ? '智能体记忆' : '用户档案';
}

/** UTF-8 byte length of a JS string, mirroring the server's len(content.encode("utf-8")).
 * Lone surrogates count as 3 bytes (same as TextEncoder's U+FFFD replacement). */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const cp = s.codePointAt(i)!;
    if (cp > 0xffff) i++; // astral char consumed two code units
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** Client-side mirror of the server's 413 boundary (262144 bytes is OK, 262145 is not). */
export function memoryFileTooLarge(content: string): boolean {
  return utf8ByteLength(content) > MEMORY_FILE_MAX_BYTES;
}

/** True when an error from the memory-file routes means the gateway's
 * hermes-mobile plugin is absent or predates the memory API (routes 404/405).
 * A 404 from the list route can only mean "routes not mounted" — when mounted
 * it always answers, even with both files missing. */
export function isMemoryPluginMissing(e: unknown): boolean {
  return e instanceof HttpError && (e.status === 404 || e.status === 405);
}

/** User-facing message for a failed memory-file save. */
export function memoryWriteErrorMessage(e: unknown): string {
  if (e instanceof HttpError) {
    if (e.status === 413) return `文件过大，记忆文件最多为 ${formatBytes(MEMORY_FILE_MAX_BYTES)}。`;
    if (e.status === 403) return '权限不足，此会话无法编辑记忆文件。';
    if (e.status === 404 || e.status === 405) return '请更新网关上的 hermes-mobile 插件后再编辑记忆。';
    if (e.status === 503) return '网关的记忆存储不可用，请重试。';
  }
  if (e instanceof Error && e.message) return e.message;
  return '保存失败，网关未接受修改。';
}
