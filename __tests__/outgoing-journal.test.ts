import { decodePending, encodePending, journalScope, type PendingState } from '../src/lib/outgoing-journal';
import { makeFile } from '../src/lib/outgoing';

const scope = journalScope('http://gateway/', 'device-1', 'work', 'stored-1');
const state = (): PendingState => ({
  draft: { text: '中文 draft', image: null, files: [] },
  queue: [{ id: 'q1', state: 'pending', draft: { text: 'tail', image: null, files: [makeFile({ uri: 'file:///private/persisted', name: '中文 报告.pdf' }, 'f')] } }],
  steers: [{ text: 'correction', unknown: true }], storedSessionId: 'stored-1',
});
it('preserves FIFO, native refs, unknown steer and durable attachment URIs across remount', () => {
  const s = state();
  s.queue.push({ id: 'q2', state: 'accepted', draft: { text: 'server head', files: [], image: null, wireText: 'server head' } });
  expect(decodePending(scope, encodePending(scope, s))).toEqual(s);
});
it('isolates gateway, identity, profile and stored session', () => {
  const raw = encodePending(scope, state());
  for (const other of [
    journalScope('http://other', 'device-1', 'work', 'stored-1'),
    journalScope('http://gateway', 'device-2', 'work', 'stored-1'),
    journalScope('http://gateway', 'device-1', 'personal', 'stored-1'),
    journalScope('http://gateway', 'device-1', 'work', 'stored-2'),
  ]) expect(() => decodePending(other, raw)).toThrow(/范围/);
});
it('restores an interrupted submit/upload as unknown, not auto-retryable', () => {
  const s = state();
  s.queue[0].state = 'sending';
  s.queue[0].draft.submitUnknown = true;
  s.queue[0].draft.files[0].status = 'uploading';
  const restored = decodePending(scope, encodePending(scope, s));
  expect(restored.queue[0].state).toBe('unknown');
  expect(restored.queue[0].draft.files[0].status).toBe('unknown');
  expect(restored.steers[0].unknown).toBe(true);
});
it('can safely resume a read-only interruption before any network effect', () => {
  const s = state();
  s.queue[0].state = 'sending';
  s.queue[0].draft.files[0].status = 'reading';
  const restored = decodePending(scope, encodePending(scope, s));
  expect(restored.queue[0].state).toBe('pending');
  expect(restored.queue[0].draft.files[0].status).toBe('ready');
});
