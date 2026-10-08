import { RpcError } from '../src/api/gatewayClient';
import {
  approvalResult,
  clarifySingleResult,
  clarifySkipAllResult,
  createRequestResponder,
  valueResult,
  type ResponderDeps,
} from '../src/lib/request-answers';
import { initialTurnModel, reduceTurn, type RequestCardState, type TurnAction, type TurnModel } from '../src/lib/turn-controller';

const base = (over: Partial<RequestCardState>): RequestCardState => ({
  id: 'srq-1', kind: 'approval', method: 'approval', params: {}, status: 'pending',
  legacy: false, receivedAt: 0, anchorKey: null, ...over,
});

/** The responder guards on the STORE's card, as the screen wires it (final review m1): cards are put in
 * the store with `card()` / `clarify()`, and every dispatched action is reduced into it. */
function harness(respondOk = true) {
  let model: TurnModel = initialTurnModel();
  const put = (c: RequestCardState) => {
    model = { ...model, requests: [...model.requests.filter((r) => r.id !== c.id), c] };
    return c;
  };
  const actions: TurnAction[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const replies: Record<string, unknown[]> = {};
  const respond = jest.fn((_id: string, _r: Record<string, unknown>) => respondOk);
  const drop = jest.fn();
  const deps: ResponderDeps = {
    registry: { respond, drop },
    call: (async (method: string, params: unknown) => {
      calls.push({ method, params });
      const next = replies[method]?.shift();
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as ResponderDeps['call'],
    dispatch: (a) => {
      actions.push(a);
      model = reduceTurn(model, a);
    },
    liveSessionId: () => 'live-1',
    current: (id) => model.requests.find((r) => r.id === id),
  };
  return {
    r: createRequestResponder(deps),
    actions,
    calls,
    respond,
    drop,
    reply: (m: string, ...v: unknown[]) => (replies[m] = v),
    /** Put a card in the store (as the router does) and return it — the object a render holds. */
    card: (over: Partial<RequestCardState> = {}) => put(base(over)),
    clarify: (over: Partial<RequestCardState> = {}) => put(base({ kind: 'clarify', method: 'clarify', ...over })),
    status: (id = 'srq-1') => model.requests.find((r) => r.id === id)?.status,
  };
}

test('result builders match the wire contract exactly', () => {
  expect(approvalResult('once')).toEqual({ choice: 'once' });
  expect(clarifySingleResult('')).toEqual({ answer: '' });
  expect(clarifySkipAllResult()).toEqual({});
  expect('answers' in clarifySkipAllResult()).toBe(false);
  expect(valueResult('v')).toEqual({ value: 'v' });
});

describe('approve', () => {
  it('0.21.5: responds {choice} through the registry, optimistic, no RPC, never `all`', async () => {
    const h = harness();
    expect(await h.r.approve(h.card({}), 'once')).toEqual({ ok: true });
    expect(h.respond).toHaveBeenCalledWith('srq-1', { choice: 'once' });
    expect(h.actions).toEqual([{ type: 'request.answered', id: 'srq-1', resolution: 'once' }]);
    expect(h.calls).toHaveLength(0);
  });
  it('0.21.5: unknown id in the registry → card closed, error outcome', async () => {
    const h = harness(false);
    expect(await h.r.approve(h.card({}), 'deny')).toEqual({ ok: false, message: '此请求已关闭。' });
    expect(h.actions).toEqual([{ type: 'request.cancelled', id: 'srq-1', reason: 'session_closed' }]);
  });
  it('a settled card is not answered twice (double tap)', async () => {
    const h = harness();
    await h.r.approve(h.card({ status: 'answered' }), 'once');
    expect(h.respond).not.toHaveBeenCalled();
  });
  it('legacy: approval.respond {session_id, choice}; resolved>0 answers, 0 closes', async () => {
    const h = harness();
    h.reply('approval.respond', { resolved: 1 }, { resolved: 0 });
    await h.r.approve(h.card({ id: 'legacy:1', legacy: true }), 'deny');
    await h.r.approve(h.card({ id: 'legacy:2', legacy: true }), 'once');
    expect(h.calls).toEqual([
      { method: 'approval.respond', params: { session_id: 'live-1', choice: 'deny' } },
      { method: 'approval.respond', params: { session_id: 'live-1', choice: 'once' } },
    ]);
    expect(h.actions).toEqual([
      { type: 'request.answering', id: 'legacy:1' },
      { type: 'request.answered', id: 'legacy:1', resolution: 'deny' },
      { type: 'request.answering', id: 'legacy:2' },
      { type: 'request.cancelled', id: 'legacy:2', reason: 'resolved' },
    ]);
  });
  it('legacy: RPC failure re-arms the card', async () => {
    const h = harness();
    h.reply('approval.respond', new RpcError('socket closed', -1));
    expect(await h.r.approve(h.card({ id: 'legacy:1', legacy: true }), 'once')).toEqual({ ok: false, message: 'socket closed' });
    expect(h.actions.at(-1)).toEqual({ type: 'request.failed', id: 'legacy:1' });
  });
  it('answer again after re-delivery goes through the registry again (Review Focus 2)', async () => {
    const h = harness();
    await h.r.approve(h.card({}), 'once');
    await h.r.approve(h.card({ status: 'pending' }), 'once'); // re-delivered: pending again in the store
    expect(h.respond).toHaveBeenCalledTimes(2);
  });
});

describe('clarify', () => {
  it('single: {answer}, never clarify.lock; "" is a skip; multi-select joins as a JSON array string', () => {
    const h = harness();
    h.r.clarifySingle(h.clarify(), 'Blue');
    h.r.clarifySingle(h.clarify({ id: 'srq-2' }), '');
    h.r.clarifySingle(h.clarify({ id: 'srq-3' }), ['A', 'C']);
    expect(h.respond.mock.calls).toEqual([
      ['srq-1', { answer: 'Blue' }],
      ['srq-2', { answer: '' }],
      ['srq-3', { answer: '["A","C"]' }],
    ]);
    expect(h.calls).toHaveLength(0);
    expect(h.actions).toEqual([
      { type: 'request.answered', id: 'srq-1', skipped: false, resolution: 'Blue' },
      { type: 'request.answered', id: 'srq-2', skipped: true, resolution: '' },
      { type: 'request.answered', id: 'srq-3', skipped: false, resolution: 'A, C' },
    ]);
  });
  it('lock: ok with remaining → locked; remaining [] → locked + answered (no response frame); resolving drops the registry entry (Preflight F11)', async () => {
    const h = harness();
    h.reply('clarify.lock', { status: 'ok', remaining: ['q1'] }, { status: 'ok', remaining: [] });
    expect(await h.r.clarifyLock(h.clarify(), 'q0', ['a', 'b'])).toBe('ok');
    expect(h.drop).not.toHaveBeenCalled();
    expect(await h.r.clarifyLock(h.clarify(), 'q1', '')).toBe('resolved');
    expect(h.calls).toEqual([
      { method: 'clarify.lock', params: { request_id: 'srq-1', question_id: 'q0', answer: ['a', 'b'] } },
      { method: 'clarify.lock', params: { request_id: 'srq-1', question_id: 'q1', answer: '' } },
    ]);
    expect(h.actions).toEqual([
      { type: 'request.locked', id: 'srq-1', qid: 'q0', answer: ['a', 'b'] },
      { type: 'request.locked', id: 'srq-1', qid: 'q1', answer: '' },
      { type: 'request.answered', id: 'srq-1' },
    ]);
    expect(h.respond).not.toHaveBeenCalled();
    expect(h.drop).toHaveBeenCalledTimes(1);
    expect(h.drop).toHaveBeenCalledWith('srq-1');
  });
  it('lock: expired → 已超时', async () => {
    const h = harness();
    h.reply('clarify.lock', { status: 'expired' });
    expect(await h.r.clarifyLock(h.clarify(), 'q0', 'x')).toBe('expired');
    expect(h.actions).toEqual([{ type: 'request.cancelled', id: 'srq-1', reason: 'timeout' }]);
    expect(h.drop).not.toHaveBeenCalled();
  });
  it('lock: RPC failure → failed, no state change', async () => {
    const h = harness();
    h.reply('clarify.lock', new RpcError('bad qid', 4002));
    expect(await h.r.clarifyLock(h.clarify(), 'q9', 'x')).toBe('failed');
    expect(h.actions).toEqual([]);
    expect(h.drop).not.toHaveBeenCalled();
  });
  it('lock on a non-pending card does nothing', async () => {
    const h = harness();
    expect(await h.r.clarifyLock(h.clarify({ status: 'answering' }), 'q0', 'x')).toBe('failed');
    expect(h.calls).toHaveLength(0);
  });
  it('submitAll locks the given个问题 in order and resolves', async () => {
    const h = harness();
    h.reply('clarify.lock', { status: 'ok', remaining: ['q2'] }, { status: 'ok', remaining: [] });
    expect(await h.r.clarifySubmitAll(h.clarify(), [{ qid: 'q1', answer: 'x' }, { qid: 'q2', answer: '' }])).toBe('resolved');
    expect(h.calls.map((c) => (c.params as { question_id: string }).question_id)).toEqual(['q1', 'q2']);
    expect(h.actions[0]).toEqual({ type: 'request.answering', id: 'srq-1' });
    expect(h.drop).toHaveBeenCalledWith('srq-1');
  });
  it('submitAll stops at expired (Review Focus 4)', async () => {
    const h = harness();
    h.reply('clarify.lock', { status: 'ok', remaining: ['q2'] }, { status: 'expired' });
    expect(await h.r.clarifySubmitAll(h.clarify(), [{ qid: 'q1', answer: 'x' }, { qid: 'q2', answer: 'y' }, { qid: 'q3', answer: 'z' }])).toBe('expired');
    expect(h.calls).toHaveLength(2);
    expect(h.actions.at(-1)).toEqual({ type: 'request.cancelled', id: 'srq-1', reason: 'timeout' });
  });
  it('submitAll failure mid-way keeps earlier locks and re-arms the card (Review Focus 4)', async () => {
    const h = harness();
    h.reply('clarify.lock', { status: 'ok', remaining: ['q2'] }, new RpcError('socket closed', -1));
    expect(await h.r.clarifySubmitAll(h.clarify(), [{ qid: 'q1', answer: 'x' }, { qid: 'q2', answer: 'y' }])).toBe('failed');
    expect(h.actions).toEqual([
      { type: 'request.answering', id: 'srq-1' },
      { type: 'request.locked', id: 'srq-1', qid: 'q1', answer: 'x' },
      { type: 'request.failed', id: 'srq-1' },
    ]);
  });
  it('submitAll: every lock returns ok but the gateway still lists open question ids → request.failed + \'ok\' (Preflight F11)', async () => {
    const h = harness();
    h.reply('clarify.lock', { status: 'ok', remaining: ['q2'] }, { status: 'ok', remaining: ['q99'] });
    expect(await h.r.clarifySubmitAll(h.clarify(), [{ qid: 'q1', answer: 'x' }, { qid: 'q2', answer: 'y' }])).toBe('ok');
    expect(h.actions).toEqual([
      { type: 'request.answering', id: 'srq-1' },
      { type: 'request.locked', id: 'srq-1', qid: 'q1', answer: 'x' },
      { type: 'request.locked', id: 'srq-1', qid: 'q2', answer: 'y' },
      { type: 'request.failed', id: 'srq-1' },
    ]);
    expect(h.drop).not.toHaveBeenCalled();
  });
  it('skipAll responds with no answers (cancel-all)', () => {
    const h = harness();
    expect(h.r.clarifySkipAll(h.clarify())).toEqual({ ok: true });
    expect(h.respond).toHaveBeenCalledWith('srq-1', {});
    expect(h.actions).toEqual([{ type: 'request.answered', id: 'srq-1', skipped: true }]);
  });
});

describe('value (sudo/secret)', () => {
  const SECRET = 'sk-live-DO-NOT-LEAK-4242';
  it('responds {value} and dispatches nothing that contains the value', () => {
    const h = harness();
    expect(h.r.value(h.card({ kind: 'secure-entry', method: 'secret' }), SECRET)).toEqual({ ok: true });
    expect(h.respond).toHaveBeenCalledWith('srq-1', { value: SECRET });
    expect(h.actions).toEqual([{ type: 'request.answered', id: 'srq-1', skipped: false }]);
    expect(JSON.stringify(h.actions)).not.toContain(SECRET);
  });
  it('"" is Skip', () => {
    const h = harness();
    h.r.value(h.card({ kind: 'secure-entry', method: 'sudo' }), '');
    expect(h.respond).toHaveBeenCalledWith('srq-1', { value: '' });
    expect(h.actions).toEqual([{ type: 'request.answered', id: 'srq-1', skipped: true }]);
  });
});

// Final review m1: a second press whose handler still holds the card from an older render (still
// `pending`) must not send a second frame. On the legacy path a second approval.respond would resolve
// the NEXT queued approval with a choice the user never reviewed.
describe('answers guard on the store, not the rendered card (m1)', () => {
  it('0.21.5 approve: two synchronous taps on one render send one response frame', async () => {
    const h = harness();
    const rendered = h.card({});
    await Promise.all([h.r.approve(rendered, 'once'), h.r.approve(rendered, 'once')]);
    expect(h.respond).toHaveBeenCalledTimes(1);
    expect(h.status()).toBe('answered');
  });
  it('legacy approve: two synchronous taps send one approval.respond', async () => {
    const h = harness();
    h.reply('approval.respond', { resolved: 1 }, { resolved: 1 });
    const rendered = h.card({ id: 'legacy:1', legacy: true });
    const second = h.card({ id: 'legacy:2', legacy: true }); // next in the FIFO queue
    await Promise.all([h.r.approve(rendered, 'once'), h.r.approve(rendered, 'once')]);
    expect(h.calls).toHaveLength(1);
    expect(h.status('legacy:2')).toBe(second.status); // untouched
  });
  it('clarify single, skip all and value: a second synchronous answer sends nothing', () => {
    const h = harness();
    const single = h.clarify({ id: 'c1' });
    h.r.clarifySingle(single, 'Blue');
    h.r.clarifySingle(single, 'Red');
    const batch = h.clarify({ id: 'c2' });
    h.r.clarifySkipAll(batch);
    h.r.clarifySkipAll(batch);
    const secret = h.card({ id: 's1', kind: 'secure-entry', method: 'secret' });
    h.r.value(secret, 'v');
    h.r.value(secret, 'v');
    expect(h.respond.mock.calls.map((c) => c[0])).toEqual(['c1', 'c2', 's1']);
  });
  it('a lock tapped while 全部提交 is in flight is not sent', async () => {
    const h = harness();
    h.reply('clarify.lock', { status: 'ok', remaining: [] });
    const rendered = h.clarify();
    const all = h.r.clarifySubmitAll(rendered, [{ qid: 'q0', answer: 'x' }]);
    expect(await h.r.clarifyLock(rendered, 'q0', 'y')).toBe('failed');
    expect(await all).toBe('resolved');
    expect(h.calls).toHaveLength(1);
  });
  it('a card the store no longer has is not answered', () => {
    const h = harness();
    expect(h.r.value(base({ kind: 'secure-entry', method: 'sudo' }), 'pw')).toEqual({ ok: true });
    expect(h.respond).not.toHaveBeenCalled();
  });
});
