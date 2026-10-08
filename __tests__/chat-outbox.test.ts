import { ChatOutbox, type OutboxConnection } from '../src/lib/chat-outbox';
import { ChatJournal } from '../src/lib/chat-journal';
import { decodePending, encodePending, type PendingState } from '../src/lib/outgoing-journal';
import { DeliveryUnknownError, RpcError } from '../src/api/gatewayClient';
import { queueEditable, type Call, type Draft, type LiveSnapshot } from '../src/lib/outgoing';
import * as DocumentPicker from 'expo-document-picker';

const mockFiles = new Map<string, string>();
const mockDelete = jest.fn();
jest.mock('expo-file-system', () => {
  class File {
    uri: string;
    constructor(...parts: (string | File)[]) { this.uri = parts.map((p) => typeof p === 'string' ? p : p.uri).join('/'); }
    get exists() { return mockFiles.has(this.uri); }
    get size() { return 3; }
    async base64() {
      if (!this.exists) throw new Error('missing asset');
      return 'YWJj';
    }
    delete() { mockDelete(this.uri); mockFiles.delete(this.uri); }
  }
  return { File, Directory: class extends File {}, Paths: { document: 'file:///private' } };
});
jest.mock('expo-document-picker', () => ({ getDocumentAsync: jest.fn() }));

const empty = (text = ''): Draft => ({ text, files: [], image: null });
const state = (draft = empty()): PendingState => ({ draft, queue: [], steers: [], storedSessionId: 'stored' });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function journal(initial = state()) {
  let durable = encodePending('test', initial);
  const storage = new ChatJournal('test');
  jest.spyOn(storage, 'load').mockImplementation(async () => decodePending('test', durable));
  const save = jest.spyOn(storage, 'save').mockImplementation(async (value) => { durable = encodePending('test', value); });
  return { storage, save, durable: () => decodePending('test', durable) };
}
const mockCall = () => jest.fn<ReturnType<Call>, Parameters<Call>>() as jest.MockedFunction<Call>;
async function setup(j = journal(), call = mockCall(), snapshot: LiveSnapshot = { running: false }) {
  const box = new ChatOutbox();
  await box.initialize(j.storage);
  const accepted = jest.fn<ReturnType<OutboxConnection['accepted']>, Parameters<OutboxConnection['accepted']>>();
  const readSnapshot = jest.fn(async () => snapshot);
  box.configure({ connected: () => true, ensureSession: async () => 'live', liveSession: () => 'live', call, snapshot: readSnapshot, accepted });
  return { box, call, accepted, readSnapshot, j };
}
beforeEach(() => { mockFiles.clear(); mockDelete.mockClear(); });

test('snapshot failure becomes a visible recovery state and stops automatic read retries', async () => {
  const initial = state();
  initial.queue = [{ id: 'tail', state: 'pending', draft: empty('tail') }];
  const { box, call, readSnapshot } = await setup(journal(initial));
  readSnapshot.mockRejectedValue(new Error('offline'));
  await box.sync();
  expect(box.getSnapshot().error).toMatch(/队列.*同步.*重试/);
  expect(box.getSnapshot().polling).toBe(false);
  await box.sync();
  expect(readSnapshot).toHaveBeenCalledTimes(1);
  expect(call).not.toHaveBeenCalled();
});
test('a same-text correction seed cannot clear an active steer that is later rejected', async () => {
  const { box, call } = await setup();
  const gate = deferred<{ status: 'rejected'; text: string }>();
  const entered = deferred<void>();
  call.mockImplementation(() => { entered.resolve(); return gate.promise; });
  box.setText('repeat correction');
  const sending = box.steer();
  await entered.promise;
  box.seed({ running: true, inflight: { corrections: ['repeat correction'] } });
  gate.resolve({ status: 'rejected', text: 'repeat correction' });
  await sending;
  expect(box.getSnapshot().draft.text).toBe('repeat correction');
  expect(box.getSnapshot().blocked).toBe(false);
});

test('a queued seed cannot clear an active file submit that is later definitely rejected', async () => {
  const uri = 'file:///private/hermes-outbox/assets/owned.pdf';
  mockFiles.set(uri, 'abc');
  const draft: Draft = { ...empty('analyse'), files: [{ id: 'f', uri, name: 'a.pdf', status: 'ready' }] };
  const { box, call, accepted } = await setup(journal(state(draft)));
  const gate = deferred<never>();
  const entered = deferred<void>();
  call.mockImplementation((method) => {
    if (method === 'file.attach') return Promise.resolve({ attached: true, ref_text: '@file:a', name: 'a.pdf', path: '/host/a' });
    entered.resolve();
    return gate.promise;
  });
  const sending = box.send();
  await entered.promise;
  box.seed({ running: true, queued: { user: 'analyse\n\n@file:a' } });
  gate.reject(new RpcError('rejected', 4009));
  await sending;
  expect(box.getSnapshot().draft.text).toBe('analyse');
  expect(box.getSnapshot().draft.files).toHaveLength(1);
  expect(mockFiles.has(uri)).toBe(true);
  expect(accepted).not.toHaveBeenCalled();
});

test.each([{}, { running: true, inflight: { user: 'repeat' } }])(
  'unknown direct ACK stays blocked with an empty or stale baseline: %j', async (baseline) => {
    const { box, call, accepted } = await setup();
    box.seed(baseline);
    box.setText('repeat');
    call.mockRejectedValue(new DeliveryUnknownError('lost'));
    await box.send();
    box.seed({ running: true, inflight: { user: 'repeat', streaming: true }, queued: { user: 'repeat' } });
    expect(box.getSnapshot().draft.text).toBe('repeat');
    expect(box.getSnapshot().blocked).toBe(true);
    await box.send();
    expect(call).toHaveBeenCalledTimes(1);
    expect(accepted).not.toHaveBeenCalled();
  },
);

test('same-text unknown queue recovery never deletes 个资源, even if storage fails', async () => {
  const uri = 'file:///private/hermes-outbox/assets/owned.pdf';
  mockFiles.set(uri, 'abc');
  const initial = state();
  initial.queue = [{ id: 'head', state: 'unknown', draft: {
    ...empty('file'), wireText: 'file\n\n@file:a', submitUnknown: true,
    files: [{ id: 'f', uri, name: 'a.pdf', status: 'uploaded', upload: { sessionId: 'live', refText: '@file:a' } }],
  } }];
  const { box, j, accepted } = await setup(journal(initial), mockCall(), { running: true, queued: { user: 'file\n\n@file:a' } });
  j.save.mockRejectedValue(new Error('disk full'));
  await box.sync();
  expect(box.getSnapshot().queue[0].state).toBe('unknown');
  expect(j.durable().queue[0].state).toBe('unknown');
  expect(mockFiles.has(uri)).toBe(true);
  expect(accepted).not.toHaveBeenCalled();
});

test('a real ACK must be durable before its callback or asset deletion; retry settles without another submit', async () => {
  const uri = 'file:///private/hermes-outbox/assets/owned.pdf';
  mockFiles.set(uri, 'abc');
  const initial = state();
  initial.queue = [{ id: 'head', state: 'pending', draft: {
    ...empty('file'), files: [{ id: 'f', uri, name: 'a.pdf', status: 'uploaded', upload: { sessionId: 'live', refText: '@file:a' } }],
  } }];
  const { box, j, call, accepted } = await setup(journal(initial));
  call.mockImplementation(async () => {
    j.save.mockRejectedValue(new Error('disk full'));
    return { status: 'queued' };
  });
  await box.sync();
  expect(accepted).not.toHaveBeenCalled();
  expect(mockFiles.has(uri)).toBe(true);
  const receipts: PendingState[] = [];
  j.save.mockImplementation(async (value) => { receipts.push(JSON.parse(encodePending('test', value)).state); });
  accepted.mockImplementation(() => {
    expect(receipts.some((receipt) => receipt.queue.some((entry) => entry.state === 'accepted' && entry.draft.acceptedStatus === 'queued'))).toBe(true);
    expect(mockFiles.has(uri)).toBe(true);
  });
  await box.sync();
  expect(call).toHaveBeenCalledTimes(1);
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(mockFiles.has(uri)).toBe(false);
  expect(receipts.some((receipt) => receipt.queue.some((entry) => entry.id === 'head' && entry.state === 'accepted'))).toBe(true);
});

test('idle ordinary chat never polls, locks input, or persists attachments', async () => {
  const { box, j, call, readSnapshot } = await setup();
  await box.sync(); await box.sync();
  expect(readSnapshot).not.toHaveBeenCalled();
  expect(call).not.toHaveBeenCalled();
  expect(j.save).not.toHaveBeenCalled();
  box.setText('still editable');
  expect(box.getSnapshot().draft.text).toBe('still editable');
});

test('pause is durable and blocks an idle tail until explicitly continued', async () => {
  const initial = state();
  initial.queue = [{ id: 'tail', state: 'pending', draft: empty('tail') }];
  const { box, call, j } = await setup(journal(initial));
  call.mockResolvedValue({ status: 'streaming' });
  await box.pause();
  await box.sync();
  expect(j.durable().paused).toBe(true);
  expect(call).not.toHaveBeenCalled();
  box.continueQueue();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(call).toHaveBeenCalledTimes(1);
});

test('a failed pause persistence rejects before the screen can interrupt', async () => {
  const { box, j } = await setup();
  j.save.mockRejectedValue(new Error('disk full'));
  await expect(box.pause()).rejects.toThrow('disk full');
  expect(box.getSnapshot().paused).toBe(true);
});

test('queued ACK with failed persistence cannot be restored, cancelled, or used as receipt for an unsent draft', async () => {
  const initial = state(empty('unsent new draft'));
  initial.queue = [{ id: 'head', state: 'pending', draft: empty('accepted original') }];
  const { box, call, j, accepted } = await setup(journal(initial), mockCall(), { running: true });
  call.mockImplementation(async () => {
    j.save.mockRejectedValue(new Error('disk full'));
    return { status: 'queued' };
  });
  await box.sync();
  const entry = box.getSnapshot().queue[0];
  expect(entry.state).toBe('error');
  expect(entry.draft.acceptedStatus).toBe('queued');
  expect(queueEditable(entry)).toBe(false);
  await box.changeQueued('head', true);
  box.setText('unsent new draft');
  await box.changeQueued('head', false);
  expect(box.getSnapshot().queue[0]).toBe(entry);
  expect(entry.draft.text).toBe('accepted original');
  expect(box.getSnapshot().draft.text).toBe('unsent new draft');
  expect(accepted).not.toHaveBeenCalled();
  expect(call).toHaveBeenCalledTimes(1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(box.getSnapshot().sending).toBe(false);
  j.save.mockResolvedValue();
  box.retry('head');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(accepted.mock.calls[0][0].text).toBe('accepted original');
  expect(box.getSnapshot().draft.text).toBe('unsent new draft');
  expect(call).toHaveBeenCalledTimes(1);
});

test('direct ACK awaiting persistence locks all draft edits, and recovery only settles its original receipt', async () => {
  const uri = 'file:///private/hermes-outbox/assets/direct.pdf';
  mockFiles.set(uri, 'abc');
  const initial = state({
    ...empty('direct original'),
    files: [{ id: 'f', uri, name: 'a.pdf', status: 'uploaded', upload: { sessionId: 'live', refText: '@file:a' } }],
  });
  const { box, j, call, accepted } = await setup(journal(initial));
  const photoPicker = jest.fn(async () => ({ uri: 'file:///photo', base64: 'YWJj' }));
  call.mockImplementation(async () => {
    j.save.mockRejectedValue(new Error('disk full'));
    return { status: 'queued' };
  });
  await box.send();
  expect(box.getSnapshot().draft.acceptedStatus).toBe('queued');
  expect(box.getSnapshot().blocked).toBe(true);
  box.setText('not sent');
  box.removeFile('f');
  await box.removeImage();
  await box.pickFiles();
  await box.pickImage(photoPicker);
  box.enqueue();
  await box.steer();
  expect(box.getSnapshot().draft.text).toBe('direct original');
  expect(box.getSnapshot().draft.files).toHaveLength(1);
  expect(box.getSnapshot().queue).toHaveLength(0);
  expect(DocumentPicker.getDocumentAsync).not.toHaveBeenCalled();
  expect(photoPicker).not.toHaveBeenCalled();
  expect(accepted).not.toHaveBeenCalled();
  expect(mockFiles.has(uri)).toBe(true);
  await box.send();
  expect(accepted).not.toHaveBeenCalled();
  expect(call).toHaveBeenCalledTimes(1);
  const receipts: PendingState[] = [];
  j.save.mockImplementation(async (value) => { receipts.push(JSON.parse(encodePending('test', value)).state); });
  accepted.mockImplementation(() => {
    expect(receipts.some((receipt) => receipt.draft.acceptedStatus === 'queued')).toBe(true);
    expect(mockFiles.has(uri)).toBe(true);
  });
  await box.send();
  expect(call).toHaveBeenCalledTimes(1);
  expect(accepted).toHaveBeenCalledTimes(1);
  expect(accepted.mock.calls[0][0].text).toBe('direct original');
  expect(box.getSnapshot().draft.text).toBe('');
  expect(box.getSnapshot().blocked).toBe(false);
  expect(mockFiles.has(uri)).toBe(false);
});
