import { createReconnectOrchestrator, seedFromResume, type OrchestratorDeps, type ReconnectPhase } from '../reconnect-orchestrator';
import { closeStreaming, createCardPinner, createItemsMirror, withCardAnchors, type CardAnchors } from '../transcript-rows';
import { mergeRequestRows, type RequestCardState, type TurnAction } from '../turn-controller';

type Ev = { type: string; session_id?: string; seq?: number; payload?: unknown; replayed?: boolean };

/** Scriptable fake client + recorder. Every dep call lands in `log` so order is assertable. */
function harness(over: Partial<OrchestratorDeps> = {}) {
  const log: string[] = [];
  const applied: Ev[] = [];
  const actions: TurnAction[] = [];
  const results: Record<string, unknown[]> = {};
  let tickets = 0;
  const gates: Record<string, (() => void)[]> = {};
  const gate = (name: string) => new Promise<void>((r) => (gates[name] ??= []).push(r));
  const open = (name: string) => (gates[name] ?? []).splice(0).forEach((r) => r());
  const client = {
    isOpen: true,
    invalidate: jest.fn(() => log.push('invalidate')),
    connect: jest.fn(async (url: string) => {
      log.push(`connect:${url}`);
      const r = results.connect?.shift();
      if (r instanceof Error) throw r;
      client.isOpen = true;
    }),
    call: jest.fn(async (method: string, params: unknown) => {
      log.push(`call:${method}`);
      // NOTE (P3 harness addition): the resume gate is checked BEFORE the queued
      // result is consumed, so a held `session.resume` can be parked-against even
      // when its eventual result is an Error (the original ordering only gated a
      // successful result, since the Error branch threw before reaching the gate).
      if (method === 'session.resume' && gates.resume) await gate('resumeHeld');
      const r = results[method]?.shift();
      if (r instanceof Error) throw r;
      return r as any;
    }),
  };
  let stored: string | null = 'stored-1';
  const deps: OrchestratorDeps = {
    client: client as any,
    mintUrl: jest.fn(async () => {
      log.push('mint');
      return `ws://gw/t${++tickets}`;
    }),
    storedSessionId: () => stored,
    resumeParams: () => ({ session_id: stored! }),
    loadHistory: jest.fn(async (id: string) => {
      log.push(`history:${id}`);
      if (gates.history) await gate('historyHeld');
    }),
    dispatch: (a) => {
      actions.push(a);
      log.push(`dispatch:${a.type}`);
    },
    applyReplayedEvent: (e) => {
      applied.push(e as Ev);
      log.push(`apply:${e.type}${(e as Ev).replayed ? ':replayed' : ''}`);
    },
    onLiveSessionId: (id) => log.push(`live:${id}`),
    sleep: jest.fn(async () => {}),
    ...over,
  };
  const orch = createReconnectOrchestrator(deps);
  return {
    orch, deps, client, log, applied, actions, results, open,
    holdResume: () => (gates.resume = []),
    holdHistory: () => (gates.history = []),
    setStored: (s: string | null) => (stored = s),
  };
}

const resume = (extra: object = {}) => ({ session_id: 'live-1', message_count: 0, messages: [], info: {}, ...extra });
const since = (events: Ev[], extra: object = {}) => ({ events, latest_seq: 0, truncated: false, count: events.length, epoch: 'e1', open_requests: [], ...extra });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('sequence order', () => {
  it('mint → connect → resume → seed → history, and no replay when idle', async () => {
    const h = harness();
    h.results['session.resume'] = [resume({ running: false })];
    await h.orch.reconnect('close');
    expect(h.log).toEqual([
      'dispatch:socket.lost', 'invalidate', 'mint', 'connect:ws://gw/t1', 'call:session.resume', 'live:live-1',
      'dispatch:resume.seeded', 'history:stored-1',
    ]);
    expect(h.actions).toContainEqual({ type: 'resume.seeded', running: false });
  });

  it('running turn with a watermark: resume → history → events.since, applying only post-last-complete events', async () => {
    const h = harness();
    h.orch.noteSeq('live-1', 10);
    h.results['session.resume'] = [resume({ running: true })];
    const batch = since([
      { type: 'message.delta', session_id: 'live-1', seq: 11, payload: { text: 'old' } },
      { type: 'message.complete', session_id: 'live-1', seq: 12 },
      { type: 'message.start', session_id: 'live-1', seq: 13 },
      { type: 'message.delta', session_id: 'live-1', seq: 14, payload: { text: 'new' } },
    ]);
    h.results['session.events.since'] = [batch, batch]; // probe, then the post-history replay
    await h.orch.reconnect('foreground');
    // A1: a probe decides whether the buffer still holds the turn, THEN history, THEN the replay
    // that is applied (fetched after history so a turn finishing in between is not duplicated).
    const sinceCalls = h.log.flatMap((l, i) => (l === 'call:session.events.since' ? [i] : []));
    expect(sinceCalls).toHaveLength(2);
    expect(sinceCalls[0]).toBeLessThan(h.log.indexOf('history:stored-1'));
    expect(h.log.indexOf('history:stored-1')).toBeLessThan(sinceCalls[1]);
    expect(h.client.call).toHaveBeenCalledWith('session.events.since', { session_id: 'live-1', last_seen: 10 });
    expect(h.applied.map((e) => [e.type, e.seq, e.replayed])).toEqual([
      ['message.start', 13, true],
      ['message.delta', 14, true],
    ]);
  });

  it('decision (b): a running turn replays from the turn anchor, restoring pre-drop text', async () => {
    // RED first: before the turn anchor, last_seen is the highest seq seen (12), so the pre-drop
    // deltas (11-12) that the history replace removed never come back.
    const h = harness();
    h.orch.onLiveEvent({ type: 'message.complete', session_id: 'live-1', seq: 9 } as any); // prior turn ends
    h.orch.onLiveEvent({ type: 'message.start', session_id: 'live-1', seq: 10 } as any);
    h.orch.onLiveEvent({ type: 'message.delta', session_id: 'live-1', seq: 11, payload: { text: 'pre' } } as any);
    h.orch.onLiveEvent({ type: 'message.delta', session_id: 'live-1', seq: 12, payload: { text: '-drop' } } as any);
    h.results['session.resume'] = [resume({ running: true })];
    const batch = since([
      { type: 'message.start', session_id: 'live-1', seq: 10 },
      { type: 'message.delta', session_id: 'live-1', seq: 11, payload: { text: 'pre' } },
      { type: 'message.delta', session_id: 'live-1', seq: 12, payload: { text: '-drop' } },
      { type: 'message.delta', session_id: 'live-1', seq: 13, payload: { text: ' gap' } },
    ]);
    h.results['session.events.since'] = [batch, batch];
    h.applied.length = 0;
    await h.orch.reconnect('close');
    expect(h.client.call).toHaveBeenCalledWith('session.events.since', { session_id: 'live-1', last_seen: 9 });
    // P1: message.start@10 was already applied live (seq <= seenBefore=12), so the replayed
    // copy is skipped — a replayed message.start must not undo `stopping` (spec §5.1). Only the
    // deltas (idempotent re-renders of the same text) replay.
    expect(h.applied.map((e) => [e.type, e.seq, e.replayed])).toEqual([
      ['message.delta', 11, true],
      ['message.delta', 12, true],
      ['message.delta', 13, true],
    ]);
  });

  it('a gap-started turn: a message.start past the watermark still applies', async () => {
    const h = harness();
    // watermark 12 with no distinct turn anchor (the complete at 12 sets anchor == watermark)
    h.orch.onLiveEvent({ type: 'message.complete', session_id: 'live-1', seq: 12 } as any);
    h.applied.length = 0; // clear the priming complete's own live application
    h.results['session.resume'] = [resume({ running: true })];
    const batch = since([
      { type: 'message.start', session_id: 'live-1', seq: 13 },
      { type: 'message.delta', session_id: 'live-1', seq: 14, payload: { text: 'x' } },
    ]);
    h.results['session.events.since'] = [batch, batch];
    await h.orch.reconnect('close');
    expect(h.client.call).toHaveBeenCalledWith('session.events.since', { session_id: 'live-1', last_seen: 12 });
    expect(h.applied.map((e) => [e.type, e.seq, e.replayed])).toEqual([
      ['message.start', 13, true],
      ['message.delta', 14, true],
    ]);
  });

  it('skips replay with no watermark yet (cold start / fresh screen)', async () => {
    const h = harness();
    h.results['session.resume'] = [resume({ running: true })];
    await h.orch.reconnect('close');
    expect(h.client.call).not.toHaveBeenCalledWith('session.events.since', expect.anything());
    expect(h.actions).toContainEqual({ type: 'resume.seeded', running: true });
  });

  it('truncated with no shorter gap to ask for: history replace, nothing replayed', async () => {
    const h = harness();
    h.orch.noteSeq('live-1', 3); // anchor == watermark: the gap query would be the same query
    h.results['session.resume'] = [resume({ running: true })];
    h.results['session.events.since'] = [since([{ type: 'message.delta', session_id: 'live-1', seq: 900 }], { truncated: true })];
    await h.orch.reconnect('close');
    expect(h.client.call).toHaveBeenCalledTimes(2); // resume + one events.since
    expect(h.log).toContain('history:stored-1');
    expect(h.applied).toEqual([]);
  });

  describe('A1: the turn outgrew the replay ring (512 events)', () => {
    // Prior turn ended at 9, the running turn started at 10 and was streamed live up to 700
    // before the drop; the ring no longer reaches back to the anchor (9).
    function longTurn() {
      const h = harness();
      h.orch.onLiveEvent({ type: 'message.complete', session_id: 'live-1', seq: 9 } as any);
      h.orch.onLiveEvent({ type: 'message.start', session_id: 'live-1', seq: 10 } as any);
      h.orch.onLiveEvent({ type: 'message.delta', session_id: 'live-1', seq: 700, payload: { text: 'pre-drop' } } as any);
      h.applied.length = 0;
      h.results['session.resume'] = [resume({ running: true })];
      return h;
    }

    it('keeps the on-screen turn (no history replace) and replays only the gap after the watermark', async () => {
      // RED: before the fix the truncated anchor replay returned early AFTER the history replace
      // had removed the unpersisted row, so the turn restarted mid-sentence.
      const h = longTurn();
      h.results['session.events.since'] = [
        since([{ type: 'message.delta', session_id: 'live-1', seq: 300 }], { truncated: true }),
        since([
          { type: 'message.delta', session_id: 'live-1', seq: 700, payload: { text: 'pre-drop' } },
          { type: 'message.delta', session_id: 'live-1', seq: 701, payload: { text: ' gap' } },
          { type: 'tool.start', session_id: 'live-1', seq: 702 },
        ]),
      ];
      await h.orch.reconnect('close');
      expect(h.client.call).toHaveBeenNthCalledWith(2, 'session.events.since', { session_id: 'live-1', last_seen: 9 });
      expect(h.client.call).toHaveBeenNthCalledWith(3, 'session.events.since', { session_id: 'live-1', last_seen: 700 });
      expect(h.log).not.toContain('history:stored-1');
      expect(h.applied.map((e) => [e.type, e.seq, e.replayed])).toEqual([
        ['message.delta', 701, true],
        ['tool.start', 702, true],
      ]);
    });

    it('gap events advance the watermark, so parked live duplicates are dropped', async () => {
      const h = longTurn();
      h.holdResume(); // park live frames: they arrive while the sequence is between resume and flush
      h.results['session.events.since'] = [
        since([], { truncated: true }),
        since([{ type: 'message.delta', session_id: 'live-1', seq: 701, payload: { text: 'a' } }]),
      ];
      const run = h.orch.reconnect('close');
      await flush();
      h.orch.onLiveEvent({ type: 'message.delta', session_id: 'live-1', seq: 701, payload: { text: 'a' } } as any);
      h.orch.onLiveEvent({ type: 'message.delta', session_id: 'live-1', seq: 702, payload: { text: 'b' } } as any);
      expect(h.applied).toEqual([]);
      h.open('resumeHeld');
      await run;
      expect(h.applied.map((e) => [e.seq, !!e.replayed])).toEqual([[701, true], [702, false]]);
    });

    it('the gap is truncated too: falls back to the history replace, nothing replayed', async () => {
      const h = longTurn();
      h.results['session.events.since'] = [since([], { truncated: true }), since([], { truncated: true })];
      await h.orch.reconnect('close');
      expect(h.log).toContain('history:stored-1');
      expect(h.applied).toEqual([]);
    });

    it('the gap query fails: falls back to the history replace', async () => {
      const h = longTurn();
      h.results['session.events.since'] = [since([], { truncated: true }), new Error('transient')];
      await h.orch.reconnect('close');
      expect(h.log).toContain('history:stored-1');
      expect(h.applied).toEqual([]);
    });

    it('a backend restart (epoch change) on the probe: history replace, watermarks reset, no replay', async () => {
      const h = longTurn();
      h.orch.onLiveEvent({ type: 'gateway.ready', payload: { replay_epoch: 'e1' } } as any);
      h.results['session.events.since'] = [since([], { truncated: true, epoch: 'e2' })];
      await h.orch.reconnect('close');
      expect(h.client.call).toHaveBeenCalledTimes(2);
      expect(h.log).toContain('history:stored-1');
      expect(h.applied.filter((e) => e.type !== 'gateway.ready')).toEqual([]);
      // the reset is real: the next running reconnect has no anchor, so it does not replay at all
      h.results['session.resume'] = [resume({ running: true })];
      await h.orch.reconnect('close');
      expect(h.client.call).toHaveBeenCalledTimes(3); // + resume only
    });

    it('a turn ended in the gap (persisted): history replace, then only what follows the complete', async () => {
      // T1 finished during the drop and a prompt from another device started T2. The replace
      // brings T1's full text and T2's prompt row; replaying T1's tail on top would duplicate it.
      const h = longTurn();
      const gap = since([
        { type: 'message.delta', session_id: 'live-1', seq: 701, payload: { text: ' end' } },
        { type: 'message.complete', session_id: 'live-1', seq: 702 },
        { type: 'message.start', session_id: 'live-1', seq: 703 },
        { type: 'message.delta', session_id: 'live-1', seq: 704, payload: { text: 'T2' } },
      ]);
      h.results['session.events.since'] = [since([], { truncated: true }), gap, gap];
      await h.orch.reconnect('close');
      expect(h.log).toContain('history:stored-1');
      expect(h.applied.map((e) => [e.type, e.seq, e.replayed])).toEqual([
        ['message.start', 703, true],
        ['message.delta', 704, true],
      ]);
    });

    it('the gap is re-fetched after history, so a turn that finished during the history read is not duplicated', async () => {
      // RED (re-review minor): T2 started in the gap and completed before the history read;
      // applying the pre-history gap after the replace re-drew T2's partial text under it.
      const h = longTurn();
      h.results['session.events.since'] = [
        since([], { truncated: true }),
        since([
          { type: 'message.complete', session_id: 'live-1', seq: 702 },
          { type: 'message.start', session_id: 'live-1', seq: 703 },
          { type: 'message.delta', session_id: 'live-1', seq: 704, payload: { text: 'T2' } },
        ]),
        since([
          { type: 'message.complete', session_id: 'live-1', seq: 702 },
          { type: 'message.start', session_id: 'live-1', seq: 703 },
          { type: 'message.delta', session_id: 'live-1', seq: 704, payload: { text: 'T2' } },
          { type: 'message.complete', session_id: 'live-1', seq: 705 },
        ]),
      ];
      await h.orch.reconnect('close');
      expect(h.log.indexOf('history:stored-1')).toBeLessThan(h.log.lastIndexOf('call:session.events.since'));
      expect(h.applied).toEqual([]);
    });

    it('dispose between the probe and the gap query: nothing further is fetched or applied', async () => {
      const h = longTurn();
      let releaseProbe!: (v: unknown) => void;
      h.results['session.events.since'] = [new Promise((r) => (releaseProbe = r)) as any, since([])];
      const run = h.orch.reconnect('close');
      await flush();
      h.orch.dispose();
      releaseProbe(since([], { truncated: true }));
      await run;
      expect(h.client.call).toHaveBeenCalledTimes(2); // resume + probe only
      expect(h.log).not.toContain('history:stored-1');
      expect(h.applied).toEqual([]);
    });
  });

  describe('the probe reached the anchor (not truncated)', () => {
    function runningTurn() {
      const h = harness();
      h.orch.onLiveEvent({ type: 'message.complete', session_id: 'live-1', seq: 9 } as any);
      h.orch.onLiveEvent({ type: 'message.start', session_id: 'live-1', seq: 10 } as any);
      h.orch.onLiveEvent({ type: 'message.delta', session_id: 'live-1', seq: 11, payload: { text: 'pre' } } as any);
      h.applied.length = 0;
      h.results['session.resume'] = [resume({ running: true })];
      return h;
    }

    it('the turn finished while history loaded: the post-history batch ends in a complete, so nothing is re-applied', async () => {
      const h = runningTurn();
      h.results['session.events.since'] = [
        since([
          { type: 'message.start', session_id: 'live-1', seq: 10 },
          { type: 'message.delta', session_id: 'live-1', seq: 11, payload: { text: 'pre' } },
        ]),
        since([
          { type: 'message.start', session_id: 'live-1', seq: 10 },
          { type: 'message.delta', session_id: 'live-1', seq: 11, payload: { text: 'pre' } },
          { type: 'message.delta', session_id: 'live-1', seq: 12, payload: { text: ' done' } },
          { type: 'message.complete', session_id: 'live-1', seq: 13 },
        ]),
      ];
      await h.orch.reconnect('close');
      expect(h.log).toContain('history:stored-1');
      expect(h.applied).toEqual([]); // history already holds the finished turn: no duplicate
    });

    it('ring moved past the anchor AND the turn completed meanwhile: reload history, re-apply nothing', async () => {
      // RED (re-review minor): the fallback applied the pre-history probe over a history that
      // already held the finished turn, so the turn showed twice.
      const h = runningTurn();
      h.results['session.events.since'] = [
        since([
          { type: 'message.start', session_id: 'live-1', seq: 10 },
          { type: 'message.delta', session_id: 'live-1', seq: 11, payload: { text: 'pre' } },
          { type: 'message.delta', session_id: 'live-1', seq: 12, payload: { text: ' gap' } },
        ]),
        since([], { truncated: true }),
        since([
          { type: 'message.delta', session_id: 'live-1', seq: 13, payload: { text: ' end' } },
          { type: 'message.complete', session_id: 'live-1', seq: 14 },
        ]),
      ];
      await h.orch.reconnect('close');
      expect(h.log.filter((l) => l === 'history:stored-1')).toHaveLength(2);
      expect(h.applied).toEqual([]);
    });

    it('the ring moved past the anchor while history loaded: apply the probe, then only what followed it', async () => {
      // RED (review #1): the post-history call came back truncated and the code returned, after
      // the replace had removed the unpersisted row — A1 again, one step later.
      const h = runningTurn();
      h.results['session.events.since'] = [
        since([
          { type: 'message.start', session_id: 'live-1', seq: 10 },
          { type: 'message.delta', session_id: 'live-1', seq: 11, payload: { text: 'pre' } },
          { type: 'message.delta', session_id: 'live-1', seq: 12, payload: { text: ' gap' } },
        ]),
        since([], { truncated: true }),
        since([
          { type: 'message.delta', session_id: 'live-1', seq: 12, payload: { text: ' gap' } },
          { type: 'message.delta', session_id: 'live-1', seq: 13, payload: { text: ' more' } },
        ]),
      ];
      await h.orch.reconnect('close');
      expect(h.client.call).toHaveBeenNthCalledWith(4, 'session.events.since', { session_id: 'live-1', last_seen: 12 });
      expect(h.applied.map((e) => [e.type, e.seq, e.replayed])).toEqual([
        ['message.delta', 11, true],
        ['message.delta', 12, true],
        ['message.delta', 13, true],
      ]);
    });
  });

  it('a replay failure (0.20.4 -32601) is swallowed and the run still succeeds', async () => {
    const phases: string[] = [];
    const h = harness({ onPhase: (p) => phases.push(p.kind) });
    h.orch.noteSeq('live-1', 3);
    h.results['session.resume'] = [resume({ running: true })];
    h.results['session.events.since'] = [new Error('unknown method')];
    await h.orch.reconnect('close');
    expect(phases).toEqual(['attempt', 'ready']);
    expect(h.log).toContain('history:stored-1');
    expect(h.client.call).toHaveBeenCalledTimes(2); // no second events.since after a -32601
  });

  it('seeds from inflight.streaming alone (0.20.4 shape)', async () => {
    const h = harness();
    h.results['session.resume'] = [resume({ inflight: { streaming: true } })];
    await h.orch.reconnect('close');
    expect(h.actions).toContainEqual({ type: 'resume.seeded', running: true });
  });

  it('a fresh chat (no stored id) only connects', async () => {
    const h = harness();
    h.setStored(null);
    await h.orch.reconnect('close');
    expect(h.log).toEqual(['dispatch:socket.lost', 'invalidate', 'mint', 'connect:ws://gw/t1']);
  });
});

describe('single-flight', () => {
  it('close + heartbeat + foreground + stop-timeout during one run → one mint, one connect', async () => {
    const h = harness();
    h.holdResume();
    h.results['session.resume'] = [resume()];
    const a = h.orch.reconnect('close');
    await flush();
    const b = h.orch.reconnect('heartbeat');
    const c = h.orch.reconnect('foreground');
    const d = h.orch.reconnect('stop-timeout');
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(d).toBe(a);
    h.open('resumeHeld');
    await a;
    expect(h.deps.mintUrl).toHaveBeenCalledTimes(1);
    expect(h.client.connect).toHaveBeenCalledTimes(1);
  });

  it('start() and a foreground reconnect share one slot (initial connect holds off reconnects)', async () => {
    const h = harness();
    h.holdResume();
    h.results['session.resume'] = [resume()];
    const s = h.orch.start();
    await flush();
    expect(h.orch.reconnect('foreground')).toBe(s);
    h.open('resumeHeld');
    await s;
    expect(h.client.connect).toHaveBeenCalledTimes(1);
  });

  it("M2: a close fired synchronously by start()'s invalidate() joins start — one mint, one connect", async () => {
    // Real adapter: invalidating an open socket emits onState('closed') synchronously, and the
    // transport turns that into reconnect('close'). singleFlight must already own the slot.
    const h = harness();
    h.results['session.resume'] = [resume(), resume()];
    const joined: Promise<void>[] = [];
    h.client.invalidate.mockImplementation(() => {
      joined.push(h.orch.reconnect('close'));
      return h.log.push('invalidate');
    });
    const s = h.orch.start();
    await s;
    await Promise.all(joined);
    expect(joined.length).toBeGreaterThan(0);
    for (const j of joined) expect(j).toBe(s);
    expect(h.deps.mintUrl).toHaveBeenCalledTimes(1);
    expect(h.client.connect).toHaveBeenCalledTimes(1);
    expect(h.actions).not.toContainEqual({ type: 'socket.lost' });
  });

  it('a trigger after the run finished starts a new run', async () => {
    const h = harness();
    h.results['session.resume'] = [resume(), resume()];
    await h.orch.reconnect('close');
    await h.orch.reconnect('close');
    expect(h.client.connect).toHaveBeenCalledTimes(2);
  });

  it('retries with backoff, re-minting a ticket per attempt, then reports failed', async () => {
    const phases: string[] = [];
    const h = harness({ onPhase: (p) => phases.push(p.kind === 'attempt' ? `attempt${p.attempt}` : p.kind) });
    h.results.connect = [new Error('x'), new Error('x'), new Error('x'), new Error('x'), new Error('x')];
    await h.orch.reconnect('close');
    expect(h.deps.sleep).toHaveBeenNthCalledWith(1, 1000);
    expect(h.deps.sleep).toHaveBeenNthCalledWith(5, 8000);
    expect(h.deps.mintUrl).toHaveBeenCalledTimes(5);
    expect(phases).toEqual(['attempt1', 'attempt2', 'attempt3', 'attempt4', 'attempt5', 'failed']);
  });

  it('start({historyLoaded:true}) resumes without re-loading history (I1: first paint already did)', async () => {
    const h = harness();
    h.results['session.resume'] = [resume({ running: false })];
    await h.orch.start({ historyLoaded: true });
    expect(h.log).toEqual([
      'invalidate', 'mint', 'connect:ws://gw/t1', 'call:session.resume', 'live:live-1', 'dispatch:resume.seeded',
    ]);
    expect(h.deps.loadHistory).not.toHaveBeenCalled();
  });

  it('start() without historyLoaded still loads history (first paint failed or was skipped)', async () => {
    const h = harness();
    h.results['session.resume'] = [resume({ running: false })];
    await h.orch.start();
    expect(h.deps.loadHistory).toHaveBeenCalledTimes(1);
    expect(h.deps.loadHistory).toHaveBeenCalledWith('stored-1');
  });

  it('historyLoaded applies to the initial run only: a later reconnect still loads history', async () => {
    const h = harness();
    h.results['session.resume'] = [resume({ running: false }), resume({ running: false })];
    await h.orch.start({ historyLoaded: true });
    expect(h.deps.loadHistory).not.toHaveBeenCalled();
    await h.orch.reconnect('close');
    expect(h.deps.loadHistory).toHaveBeenCalledTimes(1);
    expect(h.deps.loadHistory).toHaveBeenCalledWith('stored-1');
  });

  it('start() is a single attempt and rejects on failure', async () => {
    const h = harness();
    h.results.connect = [new Error('offline')];
    await expect(h.orch.start()).rejects.toThrow('offline');
    expect(h.deps.sleep).not.toHaveBeenCalled();
  });
});

describe('parking live events during steps 2–4', () => {
  it('parks live events during history, applies them after replay in seq order, deduped by seq', async () => {
    const h = harness();
    h.orch.noteSeq('live-1', 10);
    h.holdHistory();
    h.results['session.resume'] = [resume({ running: true })];
    const batch = since([
      { type: 'message.delta', session_id: 'live-1', seq: 11, payload: { text: 'a' } },
      { type: 'message.delta', session_id: 'live-1', seq: 12, payload: { text: 'b' } },
    ]);
    h.results['session.events.since'] = [batch, batch];
    const run = h.orch.reconnect('close');
    await flush();
    // live frames racing the reconnect: 12 duplicates the replay, 14 arrives before 13
    h.orch.onLiveEvent({ type: 'message.delta', session_id: 'live-1', seq: 12, payload: { text: 'b' } } as any);
    h.orch.onLiveEvent({ type: 'message.delta', session_id: 'live-1', seq: 14, payload: { text: 'd' } } as any);
    h.orch.onLiveEvent({ type: 'message.delta', session_id: 'live-1', seq: 13, payload: { text: 'c' } } as any);
    expect(h.applied).toEqual([]); // nothing applied while parked
    h.open('historyHeld');
    await run;
    expect(h.applied.map((e) => [e.seq, !!e.replayed])).toEqual([
      [11, true], [12, true], [13, false], [14, false],
    ]);
  });

  it('after the run, live events apply immediately and advance the watermark', async () => {
    const h = harness();
    h.results['session.resume'] = [resume()];
    await h.orch.reconnect('close');
    h.orch.onLiveEvent({ type: 'message.delta', session_id: 'live-1', seq: 5 } as any);
    expect(h.applied.map((e) => e.seq)).toEqual([5]);
    h.results['session.resume'] = [resume({ running: true })];
    h.results['session.events.since'] = [since([])];
    await h.orch.reconnect('close');
    expect(h.client.call).toHaveBeenCalledWith('session.events.since', { session_id: 'live-1', last_seen: 5 });
  });

  it('a failed attempt drops its parked frames; the next attempt re-resumes', async () => {
    const h = harness();
    h.holdResume();
    h.results['session.resume'] = [new Error('boom'), resume()];
    const run = h.orch.reconnect('close');
    await flush(); // attempt 1 is now blocked inside session.resume, before it rejects
    h.orch.onLiveEvent({ type: 'message.delta', session_id: 'live-1', seq: 42, payload: { text: 'parked' } } as any);
    h.open('resumeHeld'); // let attempt 1's session.resume reject
    await flush(); // let attempt 2 progress up to its own held session.resume
    h.open('resumeHeld'); // let attempt 2's session.resume resolve
    await run;
    expect(h.client.call.mock.calls.filter((c) => c[0] === 'session.resume')).toHaveLength(2);
    // the frame parked during the failed attempt died with it — it must not surface later
    expect(h.applied).toEqual([]);
  });
});

describe('socket death after resume (fix round 1)', () => {
  it('a socket that dies during history/replay makes the attempt redial instead of reporting ready on a dead socket', async () => {
    const phases: string[] = [];
    const h = harness({ onPhase: (p) => phases.push(p.kind === 'attempt' ? `attempt${p.attempt}` : p.kind) });
    h.holdHistory();
    h.results['session.resume'] = [resume({ running: false }), resume({ running: false })];
    const run = h.orch.reconnect('close');
    await flush();
    // the socket died while history (a REST call) was in flight — no code here notices
    h.client.isOpen = false;
    // a frame lands on the dying connection before the close settles: parked, dies with the attempt
    h.orch.onLiveEvent({ type: 'message.delta', session_id: 'live-1', seq: 1 } as any);
    h.open('historyHeld'); // attempt 1's history resolves; the isOpen check then fails the attempt
    await flush(); // attempt 2 progresses up to its own fresh history hold
    h.open('historyHeld'); // attempt 2's history resolves; isOpen is true again (fresh connect)
    await run;
    expect(h.deps.mintUrl).toHaveBeenCalledTimes(2);
    expect(h.client.connect).toHaveBeenCalledTimes(2);
    expect(h.applied).toEqual([]); // the dead attempt's parked frame never surfaces
    expect(phases).toEqual(['attempt1', 'attempt2', 'ready']); // ready only after the redial
  });

  it('start() rejects when the socket dies before the flush (post-resume)', async () => {
    const h = harness();
    h.holdHistory();
    h.results['session.resume'] = [resume({ running: false })];
    const s = h.orch.start();
    await flush();
    h.client.isOpen = false;
    h.open('historyHeld');
    await expect(s).rejects.toThrow('socket lost during reconnect');
  });
});

describe('epoch (backend restart)', () => {
  it('a changed gateway.ready replay_epoch clears watermarks, so replay is skipped', async () => {
    const h = harness();
    h.orch.onLiveEvent({ type: 'gateway.ready', payload: { replay_epoch: 'e1' } } as any);
    h.orch.noteSeq('live-1', 97);
    h.orch.onLiveEvent({ type: 'gateway.ready', payload: { replay_epoch: 'e2' } } as any);
    h.results['session.resume'] = [resume({ running: true })];
    await h.orch.reconnect('close');
    expect(h.client.call).not.toHaveBeenCalledWith('session.events.since', expect.anything());
  });
});

describe('dispose', () => {
  it('stops an in-flight run and makes later triggers no-ops', async () => {
    const h = harness();
    h.holdResume();
    h.results['session.resume'] = [resume()];
    const run = h.orch.reconnect('close');
    await flush();
    h.orch.dispose();
    h.open('resumeHeld');
    await run;
    expect(h.deps.loadHistory).not.toHaveBeenCalled();
    await h.orch.reconnect('foreground');
    expect(h.deps.mintUrl).toHaveBeenCalledTimes(1);
  });
});

describe('seedFromResume', () => {
  it('seeds the live session id, calls onResumed, dispatches resume.seeded, and returns running', () => {
    const dispatched: TurnAction[] = [];
    const onResumedCalls: unknown[] = [];
    const liveIds: string[] = [];
    const res = resume({ running: true });
    const running = seedFromResume(res as any, {
      onLiveSessionId: (id) => liveIds.push(id),
      onResumed: (r) => onResumedCalls.push(r),
      dispatch: (a) => dispatched.push(a),
    });
    expect(running).toBe(true);
    expect(liveIds).toEqual(['live-1']);
    expect(onResumedCalls).toEqual([res]);
    expect(dispatched).toEqual([{ type: 'resume.seeded', running: true }]);
  });

  it("forwards the resume's open_requests ids so a card it re-delivered is not closed (I2)", () => {
    const dispatched: TurnAction[] = [];
    const res = resume({ running: false, open_requests: [{ id: 'srq-a', method: 'approval', params: {} }] });
    seedFromResume(res as any, { onLiveSessionId: () => {}, dispatch: (a) => dispatched.push(a) });
    expect(dispatched).toEqual([{ type: 'resume.seeded', running: false, openRequestIds: ['srq-a'] }]);
  });

  it('returns false and works without onResumed（可选）', () => {
    const dispatched: TurnAction[] = [];
    const running = seedFromResume(resume({ running: false }) as any, {
      onLiveSessionId: () => {},
      dispatch: (a) => dispatched.push(a),
    });
    expect(running).toBe(false);
    expect(dispatched).toEqual([{ type: 'resume.seeded', running: false }]);
  });
});

// D1 (QA 2026-09-29 item 6): the screen pinned an open card under the reloaded history's last row at
// the history replace, and the replay then appended the running clarify row BELOW the card. These
// drive a real orchestrator through a stand-in for the chat screen that forwards to the card pinner
// exactly as src/app/chat/[id].tsx does, so the timing (reload → replay → parked flush → ready) is
// what is under test, not a hand-ordered call sequence.
describe('D1: request cards across a reconnect (card pinner wiring)', () => {
  type Row = { key: string; role: string; text: string; complete?: boolean; tool?: { id: string; name: string; running: boolean } };
  const user = (key: string): Row => ({ key, role: 'user', text: key, complete: true });
  const said = (key: string): Row => ({ key, role: 'assistant', text: key, complete: true });
  const clarifyRow = (key: string, running: boolean): Row => ({ key, role: 'tool', text: 'clarify', tool: { id: key, name: 'clarify', running } });
  const card = (status: RequestCardState['status'] = 'pending'): RequestCardState => ({
    id: 'card', kind: 'clarify', method: 'clarify.request', params: {}, status, legacy: false, receivedAt: 0, anchorKey: 'i1',
  });

  /** The chat screen's side: transcript mirror, turn-store cards, overrides, and the pinner forwarding. */
  function screen(histories: Row[][], afterReload: (n: number) => void = () => {}) {
    let n = 100;
    const mirror = createItemsMirror<Row>(() => {}, closeStreaming);
    mirror.update(() => [user('i0'), said('i1')]); // the transcript before the socket dropped
    const pinner = createCardPinner();
    const s = {
      requests: [card()],
      anchors: {} as CardAnchors,
      reloads: 0,
      beforePin: [] as string[], // the order the screen drew just before the sequence ended
      order: () => mergeRequestRows([...mirror.items()], withCardAnchors(s.requests, s.anchors)).map((r) => (r.kind === 'item' ? r.item.key : r.card.id)),
      endSequence: () => {
        s.beforePin = s.order();
        const pins = pinner.onSequenceEnd(s.requests, mirror.items(), mirror.anchorKey());
        if (pins) s.anchors = { ...s.anchors, ...pins };
      },
      pinner,
    };
    const deps: Partial<OrchestratorDeps> = {
      loadHistory: jest.fn(async () => {
        const reloaded = histories[s.reloads++];
        mirror.update(() => reloaded);
        s.anchors = pinner.onHistoryReplace(s.requests, {}, reloaded);
        afterReload(s.reloads);
      }),
      applyReplayedEvent: (e) => {
        const name = String((e.payload as { name?: unknown } | undefined)?.name ?? '');
        if (e.type === 'tool.start') mirror.update((prev) => [...prev, { key: `i${n++}`, role: 'tool', text: name, tool: { id: name, name, running: true } }]);
        else if (e.type === 'tool.complete') mirror.update((prev) => prev.map((r) => (r.tool?.running && r.tool.name === name ? { ...r, tool: { ...r.tool, running: false } } : r)));
        else if (e.type === 'message.delta') mirror.update((prev) => [...prev, { key: `i${n++}`, role: 'assistant', text: 'more', complete: false }]);
      },
      onPhase: (p: ReconnectPhase) => {
        if (p.kind === 'attempt') pinner.sequenceStarted();
        else s.endSequence();
      },
    };
    return { s, deps };
  }

  const ev = (type: string, seq: number, payload?: object) => ({ type, session_id: 'live-1', seq, ...(payload ? { payload } : {}) });

  it('the running clarify row replayed after the reload: the card ends up right under it', async () => {
    const { s, deps } = screen([[user('i2'), said('i3')]]);
    const h = harness(deps);
    h.orch.noteSeq('live-1', 10);
    h.results['session.resume'] = [resume({ running: true })];
    const replay = since([ev('tool.start', 11, { name: 'clarify' })]);
    h.results['session.events.since'] = [replay, replay];
    await h.orch.reconnect('foreground');
    expect(s.beforePin).toEqual(['i2', 'i3', 'i100', 'card']); // unpinned during the replay: drawn at the tail
    expect(s.order()).toEqual(['i2', 'i3', 'i100', 'card']);
    expect(s.anchors).toEqual({ card: 'i100' }); // pinned: it stays there once answered
  });

  it('answered in the window: the parked tool.complete and continuation land below the card, not above it', async () => {
    const { s, deps } = screen([[user('i2'), said('i3')]], () => (s.requests = [card('answered')]));
    const h = harness(deps);
    h.orch.noteSeq('live-1', 10);
    h.results['session.resume'] = [resume({ running: true })];
    const replay = since([ev('tool.start', 11, { name: 'clarify' })]);
    h.results['session.events.since'] = [replay, replay];
    h.holdResume();
    const run = h.orch.reconnect('close');
    await flush();
    // live frames racing the reconnect are parked, then flushed after the replay and before ready
    h.orch.onLiveEvent(ev('tool.complete', 12, { name: 'clarify' }) as any);
    h.orch.onLiveEvent(ev('message.delta', 13, { text: 'thanks' }) as any);
    h.open('resumeHeld');
    await run;
    expect(s.order()).toEqual(['i2', 'i3', 'i100', 'card', 'i101']);
  });

  it('two reloads in one sequence (the turn completed meanwhile): a card that settled between them is still drawn', async () => {
    const second = [user('i4'), said('i5'), clarifyRow('i6', false), said('i7')];
    const { s, deps } = screen([[user('i2'), said('i3')], second], (k) => {
      if (k === 1) s.requests = [card('answered')];
    });
    const h = harness(deps);
    h.orch.onLiveEvent(ev('message.complete', 9) as any);
    h.orch.onLiveEvent(ev('message.start', 10) as any);
    h.results['session.resume'] = [resume({ running: true })];
    h.results['session.events.since'] = [
      since([ev('message.start', 10), ev('tool.start', 11, { name: 'clarify' })]),
      since([], { truncated: true }),
      since([ev('tool.complete', 12, { name: 'clarify' }), ev('message.complete', 13)]),
    ];
    await h.orch.reconnect('close');
    expect(s.reloads).toBe(2);
    expect(s.order()).toEqual(['i4', 'i5', 'i6', 'i7', 'card']);
  });

  it('a failed attempt then a retry: the record survives the attempt boundary', async () => {
    let hh: ReturnType<typeof harness> | null = null;
    const { s, deps } = screen([[user('i2'), said('i3')], [user('i4'), said('i5')]], (k) => {
      if (k === 1) {
        hh!.client.isOpen = false; // the socket died while history loaded: attempt 1 fails
        s.requests = [card('answered')]; // …and the card settles before attempt 2 reloads
      }
    });
    const h = (hh = harness(deps));
    h.orch.noteSeq('live-1', 10);
    h.results['session.resume'] = [resume({ running: true }), resume({ running: true })];
    const replay = since([ev('tool.start', 11, { name: 'clarify' }), ev('tool.complete', 12, { name: 'clarify' })]);
    h.results['session.events.since'] = [replay, replay, replay, replay]; // probe + replay per attempt
    await h.orch.reconnect('close');
    expect(h.deps.mintUrl).toHaveBeenCalledTimes(2);
    expect(s.order()).toEqual(['i4', 'i5', 'i101', 'card']);
  });

  it('every attempt fails: the failed phase still pins the card, so it is drawn once it settles', async () => {
    let hh: ReturnType<typeof harness> | null = null;
    const { s, deps } = screen([[user('i2'), said('i3')]], () => (hh!.client.isOpen = false));
    const h = (hh = harness(deps));
    h.results['session.resume'] = [resume({ running: false })];
    h.results.connect = [undefined, new Error('x'), new Error('x'), new Error('x'), new Error('x')];
    await h.orch.reconnect('close');
    s.requests = [card('cancelled')];
    expect(s.order()).toEqual(['i2', 'i3', 'card']);
  });

  it('start() rejects after its history load: the screen\'s catch pins the card (finding 6)', async () => {
    let hh: ReturnType<typeof harness> | null = null;
    const { s, deps } = screen([[user('i2'), said('i3')]], () => (hh!.client.isOpen = false));
    const h = (hh = harness(deps));
    h.results['session.resume'] = [resume({ running: false })];
    s.pinner.sequenceStarted();
    await h.orch.start().catch(() => s.endSequence());
    s.requests = [card('answered')];
    expect(s.order()).toEqual(['i2', 'i3', 'card']);
  });
});
