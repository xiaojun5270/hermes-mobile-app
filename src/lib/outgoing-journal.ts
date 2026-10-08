import type { Draft, QueueEntry } from './outgoing';

export interface PendingState {
  draft: Draft;
  queue: QueueEntry[];
  steers: { text: string; unknown: boolean }[];
  storedSessionId: string | null;
  paused?: boolean;
}
export function journalScope(gateway: string, identity: string, profile: string | null, session: string): string {
  return JSON.stringify([gateway.replace(/\/+$/, ''), identity, profile, session]);
}
export function encodePending(scope: string, state: PendingState): string {
  return JSON.stringify({ version: 1, scope, state });
}
export function decodePending(scope: string, raw: string): PendingState {
  const record = JSON.parse(raw);
  if (record?.version !== 1 || record.scope !== scope) throw new Error('本地草稿范围或版本不匹配，已停止恢复。');
  const state = record.state as PendingState;
  if (!state || !Array.isArray(state.queue) || !Array.isArray(state.steers)) throw new Error('本地队列损坏，已停止自动发送。');
  const recover = (d: Draft) => {
    if (!d || typeof d.text !== 'string' || !Array.isArray(d.files)) throw new Error('本地草稿损坏，已停止自动发送。');
    for (const f of d.files) {
      if (typeof f.name !== 'string' || typeof f.uri !== 'string' || typeof f.id !== 'string') throw new Error('本地附件损坏。');
      if (f.status === 'uploading') { f.status = 'unknown'; f.error = '应用关闭时上传未确认，不会重复上传。'; }
      if (f.status === 'reading') f.status = 'ready';
    }
  };
  recover(state.draft);
  if (state.draft.acceptedStatus) {
    if (state.draft.acceptedStatus === 'queued' && !state.queue.some((e) => e.draft.wireText === state.draft.wireText)) {
      state.queue.unshift({ id: 'recovered-head', state: 'accepted', draft: state.draft });
    }
    state.draft = { text: '', files: [], image: null };
  }
  for (const entry of state.queue) {
    recover(entry.draft);
    if (entry.state === 'sending') {
      entry.state = entry.draft.acceptedStatus ? 'accepted' : entry.draft.submitUnknown ? 'unknown' :
        entry.draft.imageUnknown || entry.draft.files.some((f) => f.status === 'unknown') ? 'upload_unknown' : 'pending';
    }
  }
  state.queue = state.queue.filter((e) => e.draft.acceptedStatus !== 'streaming');
  return state;
}
