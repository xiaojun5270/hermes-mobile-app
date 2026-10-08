import { Directory, File, Paths } from 'expo-file-system';
import { decodePending, encodePending, type PendingState } from './outgoing-journal';
import type { Draft } from './outgoing';

function journalName(scope: string): string {
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < scope.length; i++) {
    a = Math.imul(a ^ scope.charCodeAt(i), 16777619);
    b = Math.imul(b, 33) ^ scope.charCodeAt(i);
  }
  return `${(a >>> 0).toString(16)}-${(b >>> 0).toString(16)}.json`;
}
function validateState(state: PendingState): void {
  const fail = () => { throw new Error('本地草稿或队列记录不完整。'); };
  const draft = (d: Draft) => {
    if (!d || typeof d.text !== 'string' || !Array.isArray(d.files)) fail();
    if (d.acceptedStatus !== undefined && d.acceptedStatus !== 'queued' && d.acceptedStatus !== 'streaming') fail();
    if (d.submitUnknown !== undefined && typeof d.submitUnknown !== 'boolean') fail();
    if (d.imageUnknown !== undefined && typeof d.imageUnknown !== 'boolean') fail();
    if (d.image !== null && (!d.image || typeof d.image.uri !== 'string' || typeof d.image.base64 !== 'string')) fail();
    for (const f of d.files) {
      if (!f || typeof f.id !== 'string' || typeof f.uri !== 'string' || typeof f.name !== 'string' ||
        !['ready', 'reading', 'uploading', 'uploaded', 'error', 'unknown'].includes(f.status)) fail();
    }
  };
  if (!state || !Array.isArray(state.queue) || !Array.isArray(state.steers)) fail();
  if (state.storedSessionId !== null && typeof state.storedSessionId !== 'string') fail();
  if (state.paused !== undefined && typeof state.paused !== 'boolean') fail();
  draft(state.draft);
  for (const entry of state.queue) {
    if (!entry || typeof entry.id !== 'string' || !['pending', 'sending', 'accepted', 'error', 'unknown', 'upload_unknown'].includes(entry.state)) fail();
    draft(entry.draft);
  }
  for (const steer of state.steers) if (!steer || typeof steer.text !== 'string' || typeof steer.unknown !== 'boolean') fail();
}

interface StoredRecord {
  revision: number;
  slot: number | null;
  state: PendingState;
}

/** Ordered dual slots in private Documents. Expo overwrite-move removes its
 * destination first, so only the inactive slot may be replaced. Complete temps
 * are recovery records too; a rename is never assumed to be atomic. */
export class ChatJournal {
  private chain: Promise<void> = Promise.resolve();
  private root = new Directory(Paths.document, 'hermes-outbox');
  constructor(readonly scope: string) {}
  private candidates(): { file: File; slot: number | null }[] {
    const name = journalName(this.scope);
    return [
      ...[0, 1].flatMap((slot) => [
        { file: new File(this.root, `${name}.slot${slot}`), slot },
        { file: new File(this.root, `${name}.slot${slot}.tmp`), slot },
      ]),
      // Legacy temps can be the only surviving record after the old overwrite-move.
      { file: new File(this.root, `${name}.tmp`), slot: null },
      { file: new File(this.root, name), slot: null },
    ];
  }
  private async latest(): Promise<{ record: StoredRecord | null; damaged: boolean }> {
    let record: StoredRecord | null = null;
    let damaged = false;
    for (const { file, slot } of this.candidates()) {
      if (!file.exists) continue;
      try {
        const raw = await file.text();
        const parsed = JSON.parse(raw) as { version?: unknown; scope?: unknown; revision?: unknown; commit?: unknown; state: PendingState };
        if (parsed?.version !== 1 || parsed.scope !== this.scope) throw new Error('scope/version mismatch');
        const legacy = slot === null && parsed.revision === undefined && parsed.commit === undefined;
        const revision = legacy ? 0 : parsed.revision;
        if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < (legacy ? 0 : 1) ||
          (!legacy && parsed.commit !== 'complete')) throw new Error('invalid revision/commit');
        validateState(parsed.state);
        const state = decodePending(this.scope, raw);
        if (!record || revision > record.revision) record = { revision, slot, state };
      } catch {
        damaged = true;
      }
    }
    if (!record && damaged) throw new Error('本地队列记录损坏或范围不匹配，已停止恢复；不会当作空会话覆盖。');
    return { record, damaged };
  }
  async load(): Promise<PendingState | null> {
    await this.chain.catch(() => {});
    const { record, damaged } = await this.latest();
    if (!record) return null;
    const state = record.state;
    if (damaged) {
      // A missing newer checkpoint could have preceded a network side effect.
      // Preserve the fallback, but never automatically replay its pending entries.
      state.paused = true;
      if (!state.draft.acceptedStatus && (state.draft.text || state.draft.files.length || state.draft.image)) state.draft.submitUnknown = true;
      for (const entry of state.queue) {
        if (entry.state !== 'accepted' && !entry.draft.acceptedStatus) {
          entry.state = 'unknown';
          entry.draft.submitUnknown = true;
          entry.error = '较新本地记录损坏，已保留旧记录并暂停重发。';
        }
      }
      for (const steer of state.steers) steer.unknown = true;
    }
    return state;
  }
  save(state: PendingState): Promise<void> {
    const json = encodePending(this.scope, state);
    const write = this.chain.catch(() => {}).then(async () => {
      const payload = JSON.parse(json) as { state: PendingState };
      validateState(payload.state);
      this.root.create({ idempotent: true, intermediates: true });
      const { record } = await this.latest();
      const revision = (record?.revision ?? 0) + 1;
      if (!Number.isSafeInteger(revision)) throw new Error('本地队列版本已超过安全范围。');
      const slot = record?.slot === 0 ? 1 : 0;
      const target = new File(this.root, `${journalName(this.scope)}.slot${slot}`);
      const temp = new File(this.root, `${journalName(this.scope)}.slot${slot}.tmp`);
      const committed = JSON.stringify({ ...payload, revision, commit: 'complete' });
      temp.write(committed);
      if (await temp.text() !== committed) throw new Error('本地队列临时记录校验失败。');
      await temp.move(target, { overwrite: true });
    });
    this.chain = write;
    return write;
  }
  async remove(): Promise<void> {
    await this.chain.catch(() => {});
    for (const { file } of this.candidates()) if (file.exists) file.delete();
  }
}
export async function retainPickedFile(uri: string, id: string): Promise<string> {
  const root = new Directory(Paths.document, 'hermes-outbox', 'assets');
  root.create({ idempotent: true, intermediates: true });
  const target = new File(root, `${Date.now()}-${id}`);
  await new File(uri).copy(target);
  return target.uri;
}
export function releasePickedFile(uri: string): void {
  const root = new Directory(Paths.document, 'hermes-outbox', 'assets');
  if (!uri.startsWith(`${root.uri.replace(/\/+$/, '')}/`)) return;
  const file = new File(uri);
  if (file.exists) file.delete();
}
