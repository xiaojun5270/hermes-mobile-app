import { DeliveryUnknownError, RpcError } from '../api/gatewayClient';
import type { RpcMethods } from '../vendor/hermes-gateway';
import { base64ByteLength, buildAttachParams, type PickedImage } from './image-attach';
import { sessionReadiness } from './session-readiness';

// Mobile memory/frame budget, not a claimed file.attach server limit.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 8;
export const MAX_TOTAL_FILE_BYTES = 25 * 1024 * 1024;
type DeliveryMethod = 'file.attach' | 'image.attach_bytes' | 'image.detach' | 'prompt.submit' | 'session.steer';
export type Call = <M extends DeliveryMethod>(method: M, params: RpcMethods[M]['params']) => Promise<RpcMethods[M]['result']>;
export function deliveryUnknown(e: unknown): boolean {
  return e instanceof DeliveryUnknownError || (e instanceof RpcError && e.code === -1);
}
export type AttachmentState = 'ready' | 'reading' | 'uploading' | 'uploaded' | 'error' | 'unknown';
export interface StagedFile {
  id: string;
  uri: string;
  name: string;
  size?: number;
  mimeType?: string;
  base64?: string;
  status: AttachmentState;
  error?: string;
  upload?: { sessionId: string; refText: string };
}
export interface Draft {
  text: string;
  files: StagedFile[];
  image: PickedImage | null;
  imageUpload?: { sessionId: string; path: string };
  imageUnknown?: boolean;
  submitUnknown?: boolean;
  wireText?: string;
  acceptedStatus?: 'streaming' | 'queued';
  proofBefore?: { queued?: string; inflight?: string };
}
export interface QueueEntry {
  id: string;
  draft: Draft;
  state: 'pending' | 'sending' | 'accepted' | 'error' | 'unknown' | 'upload_unknown';
  error?: string;
}
export interface LiveSnapshot {
  running?: boolean | null;
  status?: string | null;
  inflight?: { user?: string; assistant?: string; streaming?: boolean; corrections?: string[] | null } | null;
  queued?: { user?: string } | null;
}

export function makeFile(asset: { uri: string; name: string; size?: number; mimeType?: string }, id: string): StagedFile {
  if (asset.size !== undefined && asset.size > MAX_FILE_BYTES) throw new Error(`${asset.name}: 文件超过手机端 10 MB 限制。`);
  return { ...asset, id, status: 'ready' };
}
export function validateFiles(files: StagedFile[]): void {
  if (files.length > MAX_FILES) throw new Error(`一次最多选择 ${MAX_FILES} 个文件。`);
  if (files.reduce((n, f) => n + (f.size ?? 0), 0) > MAX_TOTAL_FILE_BYTES) {
    throw new Error('文件总大小超过手机端 25 MB 限制。');
  }
}
export function buildFileParams(sid: string, file: StagedFile, base64: string): RpcMethods['file.attach']['params'] {
  if (base64ByteLength(base64) > MAX_FILE_BYTES) throw new Error(`${file.name}: 文件超过手机端 10 MB 限制。`);
  const mime = /^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType ?? '') ? file.mimeType! : 'application/octet-stream';
  return { session_id: sid, data_url: `data:${mime};base64,${base64}`, name: file.name };
}
export function fileSize(size?: number): string {
  if (size === undefined) return '大小未知';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
export function snapshotBusy(s: LiveSnapshot): boolean {
  return sessionReadiness(s) !== 'idle' || Boolean(s.queued?.user);
}

/** A cancellable local FIFO fronts the gateway's non-cancellable, merging queue.
 * At most one entry is handed off; completion events only trigger a snapshot read. */
export class Outgoing {
  queue: QueueEntry[] = [];
  private counter = 0;
  private busy = false;
  constructor(
    private readonly read: (uri: string) => Promise<string>,
    private readonly changed: () => void = () => {},
    private readonly accepted: (draft: Draft, status: 'streaming' | 'queued', key: string) => void = () => {},
    private readonly checkpoint: () => Promise<void> = async () => {},
  ) {}

  enqueue(draft: Draft): QueueEntry {
    const entry: QueueEntry = { id: `q${Date.now()}-${this.counter++}`, draft, state: 'pending' };
    this.queue = [...this.queue, entry];
    this.changed();
    return entry;
  }
  take(id: string): Draft | null {
    const e = this.queue.find((q) => q.id === id);
    if (!e || !queueEditable(e)) return null;
    this.queue = this.queue.filter((q) => q.id !== id);
    this.changed();
    return e.draft;
  }
  retry(id: string): void {
    const e = this.queue.find((q) => q.id === id);
    if (e?.state === 'error') { e.state = 'pending'; e.error = undefined; this.changed(); }
  }

  async submit(draft: Draft, sid: string, call: Call): Promise<{ status: 'streaming' | 'queued' }> {
    if (draft.acceptedStatus) {
      await this.checkpoint();
      return { status: draft.acceptedStatus };
    }
    if (this.busy) throw new Error('正在发送，请稍候。');
    if (draft.submitUnknown || draft.imageUnknown) throw new Error('上次发送结果未确认；不会自动重复发送。请等待重连核对。');
    this.busy = true;
    try {
      validateFiles(draft.files);
      const refs: string[] = [];
      for (const file of draft.files) {
        if (file.status === 'unknown') throw new Error(`${file.name}: 上传结果未确认，请重新选择文件后再发送。`);
        if (file.upload?.sessionId === sid) { refs.push(file.upload.refText); continue; }
        try {
          file.status = 'reading'; file.error = undefined; this.changed();
          file.base64 ??= await this.read(file.uri);
          file.size = base64ByteLength(file.base64);
          validateFiles(draft.files);
          const params = buildFileParams(sid, file, file.base64);
          file.status = 'uploading'; this.changed();
          await this.checkpoint();
          const result = await call('file.attach', params);
          if (result?.attached !== true || typeof result.ref_text !== 'string' || !result.ref_text.startsWith('@file:')) {
            throw new Error('网关未返回有效文件引用。');
          }
          file.upload = { sessionId: sid, refText: result.ref_text };
          file.status = 'uploaded'; this.changed();
          refs.push(result.ref_text);
        } catch (e) {
          file.status = deliveryUnknown(e) ? 'unknown' : 'error';
          file.error = e instanceof Error ? e.message : '文件读取或上传失败';
          this.changed();
          throw e;
        }
      }
      if (draft.image && draft.imageUpload?.sessionId !== sid) {
        try {
          draft.imageUnknown = true;
          this.changed();
          await this.checkpoint();
          const result = await call('image.attach_bytes', buildAttachParams(sid, draft.image));
          if (result?.attached !== true || !result.path) throw new Error('图片上传未被网关确认。');
          draft.imageUpload = { sessionId: sid, path: result.path };
          draft.imageUnknown = false;
        } catch (e) {
          draft.imageUnknown = deliveryUnknown(e);
          throw e;
        }
      }
      draft.wireText = [draft.text.trim(), refs.join('\n')].filter(Boolean).join('\n\n');
      try {
        // Force queue semantics even if another surface wins the idle->busy race.
        draft.submitUnknown = true;
        this.changed();
        await this.checkpoint();
        const result = await call('prompt.submit', { session_id: sid, text: draft.wireText, queued: true });
        if (result.status !== 'streaming' && result.status !== 'queued') throw new Error('网关未确认消息已接受。');
        draft.submitUnknown = false;
        draft.acceptedStatus = result.status;
        await this.checkpoint();
        return { status: result.status };
      } catch (e) {
        draft.submitUnknown = deliveryUnknown(e);
        if (!draft.submitUnknown && !draft.acceptedStatus && draft.imageUpload?.sessionId === sid) {
          try {
            const detached = await call('image.detach', { session_id: sid, path: draft.imageUpload.path });
            if (detached?.detached !== true) throw new Error('无法确认图片已移除。');
            draft.imageUpload = undefined;
          } catch {
            draft.imageUnknown = true;
            throw new Error('提交失败且无法确认图片已移除；已暂停重发，避免附件串到其他消息。');
          }
        }
        throw e;
      }
    } finally { this.busy = false; this.changed(); }
  }

  async flush(s: LiveSnapshot, sid: string, call: Call, allowSubmit = true): Promise<void> {
    if (this.busy) return;
    const head = this.queue[0];
    if (!head) return;
    const text = head.draft.wireText ?? head.draft.text.trim();
    if (head.draft.acceptedStatus && head.state !== 'accepted') {
      // An actual RPC receipt may be awaiting disk space. Never re-submit it.
      await this.persistAccepted(head, head.draft.acceptedStatus);
    }
    // Text-only resume snapshots cannot identify a lost ACK's request/row.
    if (head.state === 'unknown') return;
    if (head.state === 'accepted') {
      if (s.queued?.user === text) return;
      if (!snapshotBusy(s)) {
        this.queue = this.queue.slice(1);
        this.changed();
      } else return;
      // Never dispatch another entry until an authoritative idle snapshot.
      if (snapshotBusy(s)) return;
    } else if (head.state !== 'pending') return;
    const next = this.queue[0];
    if (!next || next.state !== 'pending') return;
    if (!allowSubmit) return;
    if (sessionReadiness(s) === 'unknown') return;
    // If we already handed off a head, don't merge another prompt into its server slot.
    if (s.queued?.user) return;
    if (next.draft.image && snapshotBusy(s)) return;
    next.state = 'sending'; this.changed();
    try {
      const result = await this.submit(next.draft, sid, call);
      await this.persistAccepted(next, result.status);
    } catch (e) {
      next.state = deliveryUnknown(e)
        ? (next.draft.submitUnknown ? 'unknown' : 'upload_unknown') : 'error';
      next.error = next.draft.acceptedStatus
        ? '网关已接受，但回执保存失败；只能重试保存，不能编辑或重新发送。'
        : e instanceof Error ? e.message : '发送失败';
    }
    this.changed();
    await this.checkpoint();
  }

  private async persistAccepted(entry: QueueEntry, status: 'streaming' | 'queued'): Promise<void> {
    const before = entry.state;
    entry.state = 'accepted';
    try {
      await this.checkpoint();
    } catch (e) {
      entry.state = before;
      throw e;
    }
    this.accepted(entry.draft, status, entry.id);
    this.changed();
  }

  async steer(text: string, sid: string, call: Call): Promise<'pending' | 'rejected'> {
    if (this.busy) throw new Error('正在发送，请稍候。');
    this.busy = true;
    try {
      const result = await call('session.steer', { session_id: sid, text: text.trim() });
      return result?.status === 'queued' ? 'pending' : 'rejected';
    } finally { this.busy = false; }
  }
}

export function queueEditable(e: QueueEntry): boolean {
  if (e.draft.acceptedStatus) return false;
  return ['pending', 'error'].includes(e.state) ||
    (e.state === 'upload_unknown' && !e.draft.submitUnknown && !e.draft.imageUnknown);
}
