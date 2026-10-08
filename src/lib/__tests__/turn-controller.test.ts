import {
  cancelLabel,
  completeStatus,
  initialTurnModel,
  kindForMethod,
  mergeRequestRows,
  reduceTurn,
  resumeRunning,
  shouldFireSideEffects,
  toCancelReason,
  turnActionFor,
  type RequestCardState,
  type TurnAction,
  type TurnModel,
} from '../turn-controller';

const run = (actions: TurnAction[], from: TurnModel = initialTurnModel()) => actions.reduce(reduceTurn, from);
const card = (over: Partial<Omit<RequestCardState, 'status'>> = {}): Omit<RequestCardState, 'status'> => ({
  id: 'srq-1', kind: 'approval', method: 'approval', params: { command: 'rm' }, legacy: false,
  receivedAt: 1000, anchorKey: 'i3', ...over,
});

describe('turn state (spec §5.1)', () => {
  it('starts idle', () => {
    expect(initialTurnModel()).toEqual({ turn: 'idle', lastStatus: null, requests: [] });
  });
  it('submit: idle → waiting; message.start → streaming; complete → idle with status', () => {
    const m = run([{ type: 'submit.sent' }, { type: 'event.message.start', replayed: false }]);
    expect(m.turn).toBe('streaming');
    expect(reduceTurn(m, { type: 'event.message.complete', status: 'complete', replayed: false })).toMatchObject({ turn: 'idle', lastStatus: 'complete' });
  });
  it('message.start with no local send → streaming (server-started turn)', () => {
    expect(run([{ type: 'event.message.start', replayed: false }]).turn).toBe('streaming');
  });
  it('interrupted complete records "interrupted" (UI shows Stopped)', () => {
    const m = run([{ type: 'event.message.start', replayed: false }, { type: 'event.message.complete', status: 'interrupted', replayed: false }]);
    expect(m).toMatchObject({ turn: 'idle', lastStatus: 'interrupted' });
  });
  it('error in waiting ends the turn; error in streaming does not', () => {
    expect(run([{ type: 'submit.sent' }, { type: 'event.error', replayed: false }])).toMatchObject({ turn: 'idle', lastStatus: 'error' });
    expect(run([{ type: 'event.message.start', replayed: false }, { type: 'event.error', replayed: false }]).turn).toBe('streaming');
  });
  it('stop.sent from waiting/streaming → stopping; stop.failed → streaming; idle ignores stop', () => {
    expect(run([{ type: 'submit.sent' }, { type: 'stop.sent' }]).turn).toBe('stopping');
    expect(run([{ type: 'event.message.start', replayed: false }, { type: 'stop.sent' }, { type: 'stop.failed' }]).turn).toBe('streaming');
    expect(run([{ type: 'stop.sent' }]).turn).toBe('idle');
  });
  it('resume.seeded running → streaming (Stop visible after reconnect), not running → idle', () => {
    expect(run([{ type: 'resume.seeded', running: true }]).turn).toBe('streaming');
    expect(run([{ type: 'submit.sent' }, { type: 'resume.seeded', running: false }]).turn).toBe('idle');
  });
  it('resume.seeded running keeps an in-flight stop as stopping', () => {
    expect(run([{ type: 'event.message.start', replayed: false }, { type: 'stop.sent' }, { type: 'resume.seeded', running: true }]).turn).toBe('stopping');
  });
  it('socket.lost keeps the turn state (NOT forced idle — replaces PR #22 setStreaming(false))', () => {
    expect(run([{ type: 'event.message.start', replayed: false }, { type: 'socket.lost' }]).turn).toBe('streaming');
  });
  it('submit while not idle is a no-op (the composer never sends a plain submit mid-turn)', () => {
    const m = run([{ type: 'event.message.start', replayed: false }]);
    expect(reduceTurn(m, { type: 'submit.sent' })).toBe(m);
  });
});

describe('side-effect gate', () => {
  it('replayed events never fire haptics / one-shots', () => {
    expect(shouldFireSideEffects({ type: 'event.message.complete', status: 'complete', replayed: true })).toBe(false);
    expect(shouldFireSideEffects({ type: 'event.message.complete', status: 'complete', replayed: false })).toBe(true);
    expect(shouldFireSideEffects({ type: 'submit.sent' })).toBe(true);
  });
});

describe('event → action', () => {
  it('maps message.start / message.complete(status) / error and carries replayed', () => {
    expect(turnActionFor({ type: 'message.start', replayed: true })).toEqual({ type: 'event.message.start', replayed: true });
    expect(turnActionFor({ type: 'message.complete', payload: { status: 'error' } })).toEqual({ type: 'event.message.complete', status: 'error', replayed: false });
    expect(turnActionFor({ type: 'error', payload: { message: 'x' } })).toEqual({ type: 'event.error', replayed: false });
    expect(turnActionFor({ type: 'message.delta' })).toBeNull();
  });
  it('completeStatus defaults to complete for absent/unknown values', () => {
    expect(completeStatus(undefined)).toBe('complete');
    expect(completeStatus({ status: 'weird' })).toBe('complete');
    expect(completeStatus({ status: 'interrupted' })).toBe('interrupted');
  });
  it('resumeRunning reads running / status / inflight', () => {
    expect(resumeRunning({ running: true })).toBe(true);
    expect(resumeRunning({ status: 'working' })).toBe(true);
    expect(resumeRunning({ status: 'waiting' })).toBe(true);
    expect(resumeRunning({ inflight: { streaming: true } })).toBe(true);
    expect(resumeRunning({ running: false, status: 'idle', inflight: null })).toBe(false);
  });
});

describe('request cards (spec §6.0)', () => {
  it('received → pending; re-delivery updates in place (no duplicate), keeps anchor and receivedAt, re-arms pending', () => {
    let m = run([{ type: 'request.received', card: card() }]);
    m = reduceTurn(m, { type: 'request.answered', id: 'srq-1' });
    m = reduceTurn(m, { type: 'request.received', card: card({ anchorKey: 'i99', receivedAt: 5000, params: { command: 'rm2' } }) });
    expect(m.requests).toEqual([expect.objectContaining({ id: 'srq-1', status: 'pending', anchorKey: 'i3', receivedAt: 1000, params: { command: 'rm2' } })]);
  });
  it('params.answers (clarify batch replay) seed lockedAnswers on first delivery and merge on re-delivery', () => {
    const clar = (answers?: Record<string, string>) =>
      card({ kind: 'clarify', method: 'clarify', params: { session_id: 's', questions: [], ...(answers ? { answers } : {}) } });
    let m = run([{ type: 'request.received', card: clar({ q0: 'a' }) }]);
    expect(m.requests[0].lockedAnswers).toEqual({ q0: 'a' });
    m = reduceTurn(m, { type: 'request.locked', id: 'srq-1', qid: 'q1', answer: ['x', 'y'] });
    m = reduceTurn(m, { type: 'request.received', card: clar({ q2: 'c' }) });
    expect(m.requests[0].lockedAnswers).toEqual({ q0: 'a', q1: ['x', 'y'], q2: 'c' });
  });
  it('re-delivery clears cancelReason and resolution (contract D2)', () => {
    let m = run([{ type: 'request.received', card: card() }, { type: 'request.answered', id: 'srq-1', resolution: 'deny' }]);
    expect(m.requests[0]).toMatchObject({ status: 'answered', resolution: 'deny' });
    m = reduceTurn(m, { type: 'request.received', card: card() });
    expect(m.requests[0].status).toBe('pending');
    expect(m.requests[0].resolution).toBeUndefined();
    expect(m.requests[0].cancelReason).toBeUndefined();
  });
  it('answering → answered (optimistic) / skipped; failed re-arms', () => {
    let m = run([{ type: 'request.received', card: card() }, { type: 'request.answering', id: 'srq-1' }]);
    expect(m.requests[0].status).toBe('answering');
    expect(reduceTurn(m, { type: 'request.failed', id: 'srq-1' }).requests[0].status).toBe('pending');
    expect(reduceTurn(m, { type: 'request.answered', id: 'srq-1', skipped: true }).requests[0].status).toBe('skipped');
  });
  it.each([
    ['interrupted', '已停止'],
    ['timeout', '已超时'],
    ['resolved', '已在其他设备回答'],
    ['session_closed', '已关闭'],
    ['shutdown', '已关闭'],
  ] as const)('cancel %s → cancelled with label "%s"', (reason, label) => {
    const m = run([{ type: 'request.received', card: card() }, { type: 'request.cancelled', id: 'srq-1', reason }]);
    expect(m.requests[0]).toMatchObject({ status: 'cancelled', cancelReason: reason });
    expect(cancelLabel(reason)).toBe(label);
  });
  it('cancel after an answer keeps the answer', () => {
    const m = run([{ type: 'request.received', card: card() }, { type: 'request.answered', id: 'srq-1' }, { type: 'request.cancelled', id: 'srq-1', reason: 'resolved' }]);
    expect(m.requests[0].status).toBe('answered');
  });
  it('unknown ids are no-ops (same object)', () => {
    const m = initialTurnModel();
    expect(reduceTurn(m, { type: 'request.cancelled', id: 'nope', reason: 'timeout' })).toBe(m);
  });
  it('turn end and socket loss close only LEGACY open cards', () => {
    const m = run([
      { type: 'request.received', card: card({ id: 'legacy:1', legacy: true }) },
      { type: 'request.received', card: card({ id: 'srq-2' }) },
    ]);
    const done = reduceTurn(m, { type: 'event.message.complete', status: 'interrupted', replayed: false });
    expect(done.requests.map((r) => [r.id, r.status, r.cancelReason])).toEqual([
      ['legacy:1', 'cancelled', 'interrupted'],
      ['srq-2', 'pending', undefined],
    ]);
    expect(reduceTurn(m, { type: 'socket.lost' }).requests[0]).toMatchObject({ status: 'cancelled', cancelReason: 'session_closed' });
  });
  it('resume.seeded running:false closes every open NON-legacy card as session_closed (review I2)', () => {
    let m = run([
      { type: 'request.received', card: card({ id: 'srq-pending' }) },
      { type: 'request.received', card: card({ id: 'srq-answering', kind: 'clarify', method: 'clarify' }) },
      { type: 'request.answering', id: 'srq-answering' },
      { type: 'request.received', card: card({ id: 'srq-answered' }) },
      { type: 'request.answered', id: 'srq-answered', resolution: 'once' },
      { type: 'request.received', card: card({ id: 'srq-timeout' }) },
      { type: 'request.cancelled', id: 'srq-timeout', reason: 'timeout' },
      { type: 'request.received', card: card({ id: 'legacy:1', legacy: true }) },
    ]);
    m = reduceTurn(m, { type: 'resume.seeded', running: false });
    expect(m.turn).toBe('idle');
    expect(m.requests.map((r) => [r.id, r.status, r.cancelReason, r.resolution])).toEqual([
      ['srq-pending', 'cancelled', 'session_closed', undefined],
      ['srq-answering', 'cancelled', 'session_closed', undefined],
      ['srq-answered', 'answered', undefined, 'once'], // settled: untouched
      ['srq-timeout', 'cancelled', 'timeout', undefined], // settled: reason kept
      ['legacy:1', 'pending', undefined, undefined], // legacy: socket.lost's job, not this rule
    ]);
    expect(cancelLabel(m.requests[0].cancelReason!)).toBe('已关闭');
  });
  it('resume.seeded running:false keeps a card the same resume re-delivered (openRequestIds)', () => {
    // The channel delivers the resume's open_requests BEFORE the resume promise resolves, so the
    // re-delivered card is already pending again when resume.seeded arrives: it must stay open.
    const m = run([
      { type: 'request.received', card: card({ id: 'srq-kept' }) },
      { type: 'request.received', card: card({ id: 'srq-gone' }) },
      { type: 'resume.seeded', running: false, openRequestIds: ['srq-kept'] },
    ]);
    expect(m.requests.map((r) => [r.id, r.status, r.cancelReason])).toEqual([
      ['srq-kept', 'pending', undefined],
      ['srq-gone', 'cancelled', 'session_closed'],
    ]);
  });
  it('resume.seeded running:true leaves open cards (and a stopping turn) alone', () => {
    const m = run([
      { type: 'event.message.start', replayed: false },
      { type: 'request.received', card: card() },
      { type: 'stop.sent' },
      { type: 'resume.seeded', running: true },
    ]);
    expect(m.turn).toBe('stopping');
    expect(m.requests[0]).toMatchObject({ status: 'pending' });
    expect(m.requests[0].cancelReason).toBeUndefined();
  });
  it('toCancelReason maps unknown wire reasons to session_closed', () => {
    expect(toCancelReason('timeout')).toBe('timeout');
    expect(toCancelReason('bogus')).toBe('session_closed');
    expect(toCancelReason(undefined)).toBe('session_closed');
  });
});

describe('kindForMethod', () => {
  it.each([
    ['approval', 'approval'], ['clarify', 'clarify'], ['sudo', 'secure-entry'], ['secret', 'secure-entry'],
    ['vault.unlock_prompt', 'vault-declined'], ['vault.save_login', 'vault-declined'], ['vault.code', 'vault-declined'],
    ['terminal.read', null], ['preview.read', null], ['preview.act', null], ['window.read', null], ['tour', null],
    ['display.install.sudo', null], ['something.new', null],
  ])('%s → %s', (method, kind) => {
    expect(kindForMethod(method)).toBe(kind);
  });
});

describe('mergeRequestRows', () => {
  const items = [{ key: 'i1' }, { key: 'i2' }, { key: 'i3' }];
  it('places each card after its anchor item', () => {
    const cards = [{ ...card({ id: 'a', anchorKey: 'i1' }), status: 'pending' as const }];
    expect(mergeRequestRows(items, cards).map((r) => (r.kind === 'item' ? r.item.key : r.card.id))).toEqual(['i1', 'a', 'i2', 'i3']);
  });
  it('after a history replace (anchors gone) open cards move to the end; settled ones are not re-rendered', () => {
    const cards = [
      { ...card({ id: 'open', anchorKey: 'gone' }), status: 'pending' as const },
      { ...card({ id: 'done', anchorKey: 'gone' }), status: 'answered' as const },
      { ...card({ id: 'first', anchorKey: null }), status: 'answered' as const },
    ];
    expect(mergeRequestRows(items, cards).map((r) => (r.kind === 'item' ? r.item.key : r.card.id))).toEqual(['first', 'i1', 'i2', 'i3', 'open']);
  });
  it('on an empty items list, a null-anchor settled card and a null-anchor open card both render (settled first, then open)', () => {
    const cards = [
      { ...card({ id: 'open', anchorKey: null }), status: 'pending' as const },
      { ...card({ id: 'settled', anchorKey: null }), status: 'answered' as const },
    ];
    expect(mergeRequestRows([] as { key: string }[], cards).map((r) => (r.kind === 'item' ? r.item.key : r.card.id))).toEqual(['settled', 'open']);
  });
});
