import { File } from 'expo-file-system';
import * as DocumentPicker from 'expo-document-picker';
import { ChatJournal, releasePickedFile, retainPickedFile } from './chat-journal';
import {
  Outgoing, makeFile, validateFiles, queueEditable, deliveryUnknown,
  MAX_FILE_BYTES, type Call, type Draft, type LiveSnapshot, type QueueEntry,
} from './outgoing';
import type { PickedImage } from './image-attach';
import type { PendingState } from './outgoing-journal';

export interface OutboxConnection {
  connected(): boolean;
  ensureSession(): Promise<string>;
  liveSession(): string | null;
  call: Call;
  snapshot(): Promise<LiveSnapshot>;
  accepted(draft: Draft, status: 'streaming' | 'queued', key: string): void;
}
export interface OutboxView {
  draft: Draft;
  queue: QueueEntry[];
  sending: boolean;
  hydrated: boolean;
  error: string | null;
  steerNote: string | null;
  remoteQueued?: string;
  blocked: boolean;
  paused: boolean;
  polling: boolean;
  syncFailed: boolean;
}
const emptyDraft = (): Draft => ({ text: '', image: null, files: [] });

/** One ownership/operation lock for draft, pickers, uploads, FIFO and steering.
 * The screen subscribes to immutable view snapshots; RPC mutations never depend
 * on React's render timing. No request-card secrets pass through this object. */
export class ChatOutbox {
  private draft = emptyDraft();
  private steers: PendingState['steers'] = [];
  private journal: ChatJournal | null = null;
  private connection: OutboxConnection | null = null;
  private storedSessionId: string | null = null;
  private busy = false;
  private activeOperation: Promise<void> | null = null;
  private syncing = false;
  private syncFailed = false;
  private paused = false;
  private disposed = false;
  private hydrated = false;
  private error: string | null = null;
  private steerNote: string | null = null;
  private remoteQueued?: string;
  private lastSnapshot: LiveSnapshot = {};
  private listeners = new Set<() => void>();
  private delivered = new Set<string>();
  private directId = 0;
  private outgoing = new Outgoing(
    (uri) => new File(uri).base64(),
    () => this.publish(),
    (draft, status, key) => this.accept(draft, status, key),
    () => this.save(),
  );
  private view: OutboxView = { draft: this.draft, queue: [], sending: false, hydrated: false, error: null, steerNote: null, blocked: false, paused: false, polling: false, syncFailed: false };

  getSnapshot = (): OutboxView => this.view;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  configure(connection: OutboxConnection): void { this.connection = connection; }
  private publish(): void {
    const blocked = Boolean(this.draft.acceptedStatus || this.draft.submitUnknown || this.draft.imageUnknown || this.steers.some((s) => s.unknown));
    const head = this.outgoing.queue[0];
    this.view = {
      draft: { ...this.draft, files: [...this.draft.files] }, queue: [...this.outgoing.queue],
      sending: this.busy, hydrated: this.hydrated, error: this.error, steerNote: this.steerNote,
      remoteQueued: this.remoteQueued,
      paused: this.paused,
      blocked,
      syncFailed: this.syncFailed,
      polling: !this.syncFailed && Boolean(this.remoteQueued || blocked || (head && (
        head.state === 'accepted' || head.state === 'unknown' || head.draft.acceptedStatus ||
        (head.state === 'pending' && !this.paused)
      ))),
    };
    if (!this.disposed) for (const listener of this.listeners) listener();
  }
  async initialize(journal: ChatJournal): Promise<string | null> {
    this.journal = journal;
    const saved = await journal.load();
    if (saved) {
      this.draft = saved.draft;
      this.outgoing.queue = saved.queue;
      this.steers = saved.steers;
      this.storedSessionId = saved.storedSessionId;
      this.paused = saved.paused === true;
      for (const e of saved.queue) if (e.state === 'accepted') this.delivered.add(e.id);
      if (this.steers.some((s) => s.unknown)) this.steerNote = '上次引导结果未确认，无法凭同文快照确认；文字保留，不自动重发。';
      if (this.draft.submitUnknown || this.draft.imageUnknown) this.error = '发送结果未确认，草稿与附件已保留；无法凭同文快照确认，不会自动重发。';
    }
    this.hydrated = true;
    this.publish();
    return this.storedSessionId;
  }
  async migrate(journal: ChatJournal, storedId: string): Promise<void> {
    const old = this.journal;
    this.journal = journal;
    this.storedSessionId = storedId;
    await this.save();
    if (old?.scope !== journal.scope) await old?.remove();
  }
  async save(): Promise<void> {
    if (!this.journal || !this.hydrated) return;
    try {
      await this.journal.save({ draft: this.draft, queue: this.outgoing.queue, steers: this.steers, storedSessionId: this.storedSessionId, paused: this.paused });
    } catch (e) {
      this.error = '无法保存本地草稿与队列；已停止发送，请检查手机存储。';
      this.publish();
      throw e;
    }
  }
  private persistEdit(): void { void this.save().catch(() => {}); this.publish(); }
  setText(text: string): void {
    if (this.busy || this.view.blocked) return;
    this.draft = { ...this.draft, text };
    this.persistEdit();
  }
  setError(message: string): void { this.error = message; this.publish(); }
  private exclusive(work: () => Promise<void>, persist = true): Promise<void> {
    if (this.busy || this.disposed || !this.hydrated) return Promise.resolve();
    this.busy = true; this.publish();
    const operation = (async () => {
      try { await work(); }
      catch (e) { this.error = e instanceof Error ? e.message : '操作失败，草稿已保留。'; }
      finally {
        if (persist) await this.save().catch(() => {});
        this.busy = false; this.publish();
      }
    })();
    this.activeOperation = operation;
    return operation;
  }
  async pickFiles(): Promise<void> {
    await this.exclusive(async () => {
      if (this.view.blocked) return;
      const result = await DocumentPicker.getDocumentAsync({ type: '*/*', multiple: true, copyToCacheDirectory: true });
      if (result.canceled || this.disposed) return;
      const additions = result.assets.map((a, i) => makeFile(a, `f${Date.now()}-${this.directId++}-${i}`));
      const files = [...this.draft.files, ...additions];
      validateFiles(files);
      const retained: string[] = [];
      try {
        for (const file of additions) {
          file.size = new File(file.uri).size;
          if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name}: 文件超过手机端 10 MB 限制。`);
          validateFiles(files);
          file.uri = await retainPickedFile(file.uri, file.id);
          retained.push(file.uri);
        }
        this.draft = { ...this.draft, files };
        await this.save();
        this.error = null;
      } catch (e) {
        for (const uri of retained) releasePickedFile(uri);
        throw e;
      }
    });
  }
  async pickImage(picker: () => Promise<PickedImage | null>): Promise<void> {
    await this.exclusive(async () => {
      if (this.view.blocked) return;
      const image = await picker();
      if (!image || this.disposed) return;
      await this.detachImage(this.draft);
      // The preview and bytes both survive the picker cache's purge.
      image.uri = await retainPickedFile(image.uri, `photo-${this.directId++}`);
      const old = this.draft.image;
      this.draft = { ...this.draft, image, imageUpload: undefined, imageUnknown: false };
      if (old) releasePickedFile(old.uri);
      this.error = null;
    });
  }
  removeFile(id: string): void {
    if (this.busy || this.view.blocked) return;
    const file = this.draft.files.find((f) => f.id === id);
    this.draft = { ...this.draft, files: this.draft.files.filter((f) => f.id !== id) };
    if (file) releasePickedFile(file.uri);
    this.persistEdit();
  }
  private async detachImage(draft: Draft): Promise<void> {
    if (draft.imageUnknown || draft.submitUnknown) throw new Error('图片发送结果未确认，不能安全移除暂存附件。');
    if (!draft.imageUpload) return;
    const c = this.connection;
    const sid = c?.liveSession();
    if (!c?.connected() || !sid) throw new Error('未连接，无法确认图片已清理。');
    const result = await c.call('image.detach', { session_id: sid, path: draft.imageUpload.path });
    if (typeof result.detached !== 'boolean') throw new Error('网关未确认图片清理结果。');
    draft.imageUpload = undefined;
  }
  async removeImage(): Promise<void> {
    await this.exclusive(async () => {
      if (this.view.blocked) return;
      await this.detachImage(this.draft);
      if (this.draft.image) releasePickedFile(this.draft.image.uri);
      this.draft = { ...this.draft, image: null };
    });
  }
  private accept(draft: Draft, status: 'streaming' | 'queued', key: string): void {
    if (this.delivered.has(key)) return;
    this.delivered.add(key);
    if (!this.disposed) this.connection?.accepted(draft, status, key);
    for (const f of draft.files) releasePickedFile(f.uri);
    // Keep image previews for this mounted transcript; durable queue doesn't need the photo URI after ACK.
  }
  enqueue(): void {
    if (this.busy || this.view.blocked || (!this.draft.text.trim() && !this.draft.image && !this.draft.files.length)) return;
    this.outgoing.enqueue(this.draft);
    this.draft = emptyDraft();
    this.error = null;
    this.persistEdit();
    void this.sync();
  }
  async send(): Promise<void> {
    if (this.view.blocked && !this.draft.acceptedStatus) return;
    if (!this.draft.acceptedStatus && (this.outgoing.queue.length || this.lastSnapshot.queued?.user)) { this.enqueue(); return; }
    await this.exclusive(async () => {
      if (this.draft.acceptedStatus) {
        await this.settleDirectReceipt();
        return;
      }
      const c = this.connection;
      if (!c?.connected() || (!this.draft.text.trim() && !this.draft.image && !this.draft.files.length)) return;
      const d = this.draft;
      const sid = await c.ensureSession();
      await this.outgoing.submit(d, sid, c.call);
      await this.settleDirectReceipt();
    });
    if (this.view.blocked) {
      this.error = this.draft.acceptedStatus
        ? '网关已接受，回执尚未保存；内容已锁定，恢复存储后仅补落盘，不重发。'
        : '发送结果未确认，草稿与附件已保留；无法凭同文快照确认，不会自动重发。';
      this.publish();
    }
  }
  private async settleDirectReceipt(): Promise<void> {
    const draft = this.draft;
    const status = draft.acceptedStatus;
    if (!status) return;
    let entry = this.outgoing.queue.find((q) => q.draft === draft);
    if (status === 'queued') {
      entry ??= this.outgoing.enqueue(draft);
      entry.state = 'accepted';
    }
    await this.save();
    if (entry) this.delivered.add(entry.id);
    this.accept(draft, status, `direct-${this.directId++}`);
    this.draft = emptyDraft();
    this.error = null;
  }
  async changeQueued(id: string, restore: boolean): Promise<void> {
    await this.exclusive(async () => {
      const e = this.outgoing.queue.find((q) => q.id === id);
      if (!e || !queueEditable(e)) return;
      if (restore && (this.draft.text || this.draft.image || this.draft.files.length)) throw new Error('请先处理当前草稿，再将队列消息改回草稿。');
      if (!restore) await this.detachImage(e.draft);
      const d = this.outgoing.take(id);
      if (!d) return;
      if (restore) this.draft = d;
      else {
        for (const f of d.files) releasePickedFile(f.uri);
        if (d.image) releasePickedFile(d.image.uri);
      }
    });
    void this.sync();
  }
  retry(id: string): void {
    if (this.busy) return;
    this.outgoing.retry(id);
    this.persistEdit();
    void this.sync();
  }
  seed(snapshot: LiveSnapshot): void {
    this.lastSnapshot = snapshot;
    const text = snapshot.queued?.user;
    this.remoteQueued = text && !this.outgoing.queue.some((e) => e.draft.wireText === text) ? text : undefined;
    // A seed is observational only: it must not mutate an operation's draft.
    // The contract has no request/row identity in queued/inflight/corrections,
    // so even after failure same-text snapshots cannot settle unknown delivery.
    this.publish();
  }
  async pause(): Promise<void> {
    this.paused = true;
    this.publish();
    await this.activeOperation;
    await this.save();
  }
  continueQueue(): void {
    void this.exclusive(async () => {
      this.paused = false;
      try { await this.save(); }
      catch (e) { this.paused = true; throw e; }
    }, false).then(() => this.sync());
  }
  private needsSnapshot(): boolean {
    return this.view.polling;
  }
  retrySync(): void {
    this.syncFailed = false;
    this.error = null;
    this.publish();
    void this.sync();
  }
  async sync(): Promise<void> {
    const c = this.connection;
    if (this.busy || this.syncing || !this.needsSnapshot() || this.disposed) return;
    if (this.draft.acceptedStatus) {
      await this.exclusive(() => this.settleDirectReceipt());
      return;
    }
    if (!c?.connected()) return;
    this.syncing = true;
    try {
      if (!c.liveSession()) {
        await this.exclusive(async () => { await c.ensureSession(); });
        if (!c.liveSession()) throw new Error('无法创建会话');
      }
      const snapshot = await c.snapshot(); // Reading alone never locks the composer.
      if (this.disposed || this.busy) return;
      this.seed(snapshot);
      const before = this.outgoing.queue.map((q) => `${q.id}:${q.state}`).join(',');
      const head = this.outgoing.queue[0];
      if (!head || ((head.state === 'error' || head.state === 'upload_unknown') && !head.draft.acceptedStatus)) return;
      await this.exclusive(async () => {
        const sid = c.liveSession();
        if (sid) await this.outgoing.flush(snapshot, sid, c.call, !this.paused);
        const after = this.outgoing.queue.map((q) => `${q.id}:${q.state}`).join(',');
        if (before !== after) await this.save();
      }, false);
    } catch {
      this.syncFailed = true;
      this.error = '队列状态同步失败，消息与附件已保留；请检查连接后重试同步。';
      this.publish();
    } finally { this.syncing = false; }
  }
  async steer(): Promise<void> {
    if (this.view.blocked) return;
    await this.exclusive(async () => {
      const c = this.connection;
      const sid = c?.liveSession();
      if (!c?.connected() || !sid) throw new Error('未连接，引导文字已保留。');
      if (this.draft.image || this.draft.files.length) throw new Error('引导只接受文字；附件请加入队列。');
      const text = this.draft.text.trim();
      if (!text) return;
      const pending = { text, unknown: true };
      this.steers.push(pending);
      await this.save(); // checkpoint BEFORE a non-idempotent injection
      try {
        const result = await this.outgoing.steer(text, sid, c.call);
        if (result === 'rejected') {
          this.steers = this.steers.filter((s) => s !== pending);
          throw new Error('网关拒绝引导，文字已保留；可加入队列。');
        }
        pending.unknown = false;
        this.steerNote = '引导已接受，未确认消费；压缩时可能转入下一轮。';
        this.error = null;
        if (!this.disposed) c.accepted(this.draft, 'queued', `steer-${this.directId++}`);
        this.draft = emptyDraft();
      } catch (e) {
        if (!deliveryUnknown(e)) this.steers = this.steers.filter((s) => s !== pending);
        else this.steerNote = '引导结果未确认，无法凭同文快照确认；文字保留，不自动重发。';
        throw e;
      }
    });
  }
  dispose(): void {
    this.disposed = true;
    void this.save().catch(() => {});
  }
}
