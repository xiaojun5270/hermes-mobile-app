import * as fs from 'node:fs';
import * as path from 'node:path';
import { ChatJournal } from '../src/lib/chat-journal';
import { encodePending, type PendingState } from '../src/lib/outgoing-journal';

let mockRoot: string;
let mockMoveFailure = false;
let mockWriteFailure: 'partial' | 'complete' | null = null;
const mockTrace: { operation: string; target: string }[] = [];
jest.mock('expo-file-system', () => {
  const disk: typeof import('node:fs') = require('node:fs');
  const paths: typeof import('node:path') = require('node:path');
  class File {
    uri: string;
    constructor(...parts: (string | File)[]) { this.uri = paths.join(...parts.map((p) => typeof p === 'string' ? p : p.uri)); }
    get exists() { return disk.existsSync(this.uri); }
    async text() { return disk.readFileSync(this.uri, 'utf8'); }
    write(value: string) {
      disk.writeFileSync(this.uri, mockWriteFailure === 'partial' ? value.slice(0, Math.floor(value.length / 2)) : value);
      mockTrace.push({ operation: 'write', target: this.uri });
      if (mockWriteFailure) throw new Error(`interrupted ${mockWriteFailure} write`);
    }
    delete() { disk.unlinkSync(this.uri); mockTrace.push({ operation: 'delete', target: this.uri }); }
    async move(target: File, options?: { overwrite?: boolean }) {
      // Match FileSystemPath.swift: deleting the destination is a separate operation.
      if (options?.overwrite && target.exists) {
        disk.unlinkSync(target.uri);
        mockTrace.push({ operation: 'remove-destination', target: target.uri });
      }
      if (mockMoveFailure) throw new Error('move failed after destination removal');
      disk.renameSync(this.uri, target.uri);
      mockTrace.push({ operation: 'move', target: target.uri });
      this.uri = target.uri;
    }
  }
  class Directory extends File {
    create() { disk.mkdirSync(this.uri, { recursive: true }); }
  }
  return { File, Directory, Paths: { get document() { return mockRoot; } } };
});
const scope = 'gateway/device/profile/session';
const state = (text: string, unknown = true): PendingState => ({
  draft: { text: '', files: [], image: null },
  queue: [{ id: 'q', state: unknown ? 'unknown' : 'pending', draft: { text, files: [], image: null, submitUnknown: unknown } }],
  steers: [], storedSessionId: 'stored',
});
const directory = () => path.join(mockRoot, 'hermes-outbox');
const records = () => fs.readdirSync(directory()).map((name) => path.join(directory(), name));
function committed() {
  return records().filter((name) => !name.endsWith('.tmp')).map((name) => ({ name, record: JSON.parse(fs.readFileSync(name, 'utf8')) }))
    .sort((a, b) => (b.record.revision ?? 0) - (a.record.revision ?? 0));
}
beforeEach(() => {
  const scratch = path.join(process.cwd(), '.expo', 'verification');
  fs.mkdirSync(scratch, { recursive: true });
  mockRoot = fs.mkdtempSync(path.join(scratch, 'journal-test-'));
  mockMoveFailure = false;
  mockWriteFailure = null;
  mockTrace.length = 0;
});
afterEach(() => { fs.rmSync(mockRoot, { recursive: true, force: true }); });

test('dual slots preserve the previous revision and load the highest valid committed record on restart', async () => {
  const journal = new ChatJournal(scope);
  await journal.save(state('one'));
  await journal.save(state('two'));
  expect(committed().map(({ record }) => record.revision)).toEqual([2, 1]);
  expect((await new ChatJournal(scope).load())?.queue[0].draft.text).toBe('two');
  await new ChatJournal(scope).save(state('three'));
  expect(committed().map(({ record }) => record.revision)).toEqual([3, 2]);
});

test('a persisted in-flight checkpoint recovers as unknown instead of replaying the previous pending queue', async () => {
  const journal = new ChatJournal(scope);
  await journal.save(state('before network', false));
  const sending = state('before network');
  sending.queue[0].state = 'sending';
  sending.queue[0].draft.files = [{ id: 'f', uri: 'file:///private/a', name: 'a.pdf', status: 'uploading' }];
  await journal.save(sending);
  const restored = await new ChatJournal(scope).load();
  expect(restored?.queue[0].state).toBe('unknown');
  expect(restored?.queue[0].draft.submitUnknown).toBe(true);
  expect(restored?.queue[0].draft.files[0].status).toBe('unknown');
});

test('actual destination removal followed by move failure retains both the previous slot and complete latest temp', async () => {
  const journal = new ChatJournal(scope);
  await journal.save(state('one'));
  await journal.save(state('two'));
  mockMoveFailure = true;
  await expect(journal.save(state('three'))).rejects.toThrow(/move failed/);
  expect(mockTrace.some(({ operation }) => operation === 'remove-destination')).toBe(true);
  expect(committed().some(({ record }) => record.state.queue[0].draft.text === 'two')).toBe(true);
  const restored = await new ChatJournal(scope).load();
  expect(restored?.queue[0].draft.text).toBe('three');
  expect(restored?.queue[0].state).toBe('unknown');
  mockMoveFailure = false;
  await new ChatJournal(scope).save(state('four'));
  expect((await new ChatJournal(scope).load())?.queue[0].draft.text).toBe('four');
});

test('a crash after complete temp write, before any rename, recovers the highest full revision', async () => {
  const journal = new ChatJournal(scope);
  await journal.save(state('one'));
  mockWriteFailure = 'complete';
  await expect(journal.save(state('two'))).rejects.toThrow(/interrupted complete/);
  expect((await new ChatJournal(scope).load())?.queue[0].draft.text).toBe('two');
});

test('partial write cannot destroy the unique confirmed slot; fallback pauses potentially delivered pending entries', async () => {
  const journal = new ChatJournal(scope);
  await journal.save(state('pending original', false));
  mockWriteFailure = 'partial';
  await expect(journal.save(state('unknown newer'))).rejects.toThrow(/interrupted partial/);
  const restored = await new ChatJournal(scope).load();
  expect(restored?.queue[0].draft.text).toBe('pending original');
  expect(restored?.paused).toBe(true);
  expect(restored?.queue[0].state).toBe('unknown');
  expect(restored?.queue[0].draft.submitUnknown).toBe(true);
  expect(committed()).toHaveLength(1);
});

test('corrupt latest commit falls back to a valid older scope/version/revision without enabling resend', async () => {
  const journal = new ChatJournal(scope);
  await journal.save(state('older', false));
  await journal.save(state('newer'));
  fs.writeFileSync(committed()[0].name, '{"truncated');
  const restored = await new ChatJournal(scope).load();
  expect(restored?.queue[0].draft.text).toBe('older');
  expect(restored?.queue[0].state).toBe('unknown');
  expect(restored?.paused).toBe(true);
});

test.each(['scope', 'version', 'revision', 'commit'])('invalid %s is excluded, not mistaken for an empty session', async (field) => {
  const journal = new ChatJournal(scope);
  await journal.save(state('one'));
  const { name, record } = committed()[0];
  record[field] = ({ scope: 'different identity', version: 99, revision: -1, commit: 'partial' })[field];
  fs.writeFileSync(name, JSON.stringify(record));
  await expect(new ChatJournal(scope).load()).rejects.toThrow();
  await expect(new ChatJournal(scope).save(state('do not overwrite'))).rejects.toThrow();
});

test('a foreign latest slot never imports another identity and matching fallback remains paused', async () => {
  const journal = new ChatJournal(scope);
  await journal.save(state('own older', false));
  await journal.save(state('own newer'));
  const { name, record } = committed()[0];
  record.scope = 'other identity';
  record.state = state('foreign');
  fs.writeFileSync(name, JSON.stringify(record));
  const restored = await new ChatJournal(scope).load();
  expect(restored?.queue[0].draft.text).toBe('own older');
  expect(restored?.paused).toBe(true);
});

test('legacy target missing after delete/move failure still recovers a complete legacy temp', async () => {
  const journal = new ChatJournal(scope);
  await journal.save(state('seed'));
  const legacy = committed()[0].name.replace(/\.slot[01]$/, '');
  for (const name of records()) fs.unlinkSync(name);
  fs.writeFileSync(`${legacy}.tmp`, encodePending(scope, state('legacy unknown')));
  const restored = await new ChatJournal(scope).load();
  expect(restored?.queue[0].draft.text).toBe('legacy unknown');
  expect(restored?.queue[0].state).toBe('unknown');
  await new ChatJournal(scope).save(state('migrated'));
  expect((await new ChatJournal(scope).load())?.queue[0].draft.text).toBe('migrated');
});

test('only a genuinely absent journal loads null; removal deletes all slots and legacy temp candidates', async () => {
  const journal = new ChatJournal(scope);
  expect(await journal.load()).toBeNull();
  await journal.save(state('one'));
  await journal.save(state('two'));
  await journal.remove();
  expect(records()).toHaveLength(0);
  expect(await new ChatJournal(scope).load()).toBeNull();
});
