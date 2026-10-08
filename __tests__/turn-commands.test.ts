import { RpcError } from '../src/api/gatewayClient';
import {
  completionEffects,
  createTurnCommands,
  restoreSteerText,
  STOP_FALLBACK_MS,
  type TurnCommandDeps,
} from '../src/lib/turn-commands';
import type { TurnAction, TurnState } from '../src/lib/turn-controller';

function harness() {
  const calls: Array<{ method: string; params: unknown }> = [];
  const actions: TurnAction[] = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const replies: Record<string, unknown[]> = {};
  let state: TurnState = 'streaming';
  let live = 'live-1';
  const onCall: Array<(method: string) => void> = [];
  const deps: TurnCommandDeps = {
    call: (async (method: string, params: unknown) => {
      calls.push({ method, params });
      onCall.forEach((f) => f(method));
      const next = replies[method]?.shift();
      if (next instanceof Error) throw next;
      return next ?? {};
    }) as unknown as TurnCommandDeps['call'],
    dispatch: (a) => {
      actions.push(a);
      if (a.type === 'stop.sent') state = 'stopping';
      if (a.type === 'stop.failed') state = 'streaming';
      if (a.type === 'submit.sent' && state === 'idle') state = 'waiting';
    },
    liveSessionId: () => live,
    turnState: () => state,
    resumeStored: jest.fn(async () => {
      live = 'live-2';
      return live; // A's ChatTransport.resumeStored() resolves the fresh live id
    }),
    reconnect: jest.fn(async () => {}),
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  };
  const reply = (method: string, ...values: unknown[]) => {
    replies[method] = values;
  };
  return { deps, calls, actions, timers, reply, onCall, setState: (s: TurnState) => (state = s) };
}

describe('stop', () => {
  it('goes to stopping, interrupts the live session, ignores the result, arms the 15 s fallback', async () => {
    const h = harness();
    h.reply('session.interrupt', { status: 'not_interrupted' });
    const out = await createTurnCommands(h.deps).stop();
    expect(out).toEqual({ ok: true });
    expect(h.actions).toEqual([{ type: 'stop.sent' }]);
    expect(h.calls).toEqual([{ method: 'session.interrupt', params: { session_id: 'live-1' } }]);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(STOP_FALLBACK_MS);
  });
  it('4001 → resumes the stored id and retries once on the new live id', async () => {
    const h = harness();
    h.reply('session.interrupt', new RpcError('session not found', 4001), { status: 'interrupted' });
    expect(await createTurnCommands(h.deps).stop()).toEqual({ ok: true });
    expect(h.deps.resumeStored).toHaveBeenCalledTimes(1);
    expect(h.calls.map((c) => c.params)).toEqual([{ session_id: 'live-1' }, { session_id: 'live-2' }]);
  });
  it('4001 twice → stop.failed and an inline error', async () => {
    const h = harness();
    h.reply('session.interrupt', new RpcError('gone', 4001), new RpcError('gone again', 4001));
    const out = await createTurnCommands(h.deps).stop();
    expect(out).toEqual({ ok: false, message: 'gone again' });
    expect(h.actions).toEqual([{ type: 'stop.sent' }, { type: 'stop.failed' }]);
    expect(h.timers).toHaveLength(0);
  });
  it('any other error → stop.failed, Stop re-enabled, no resume', async () => {
    const h = harness();
    h.reply('session.interrupt', new RpcError('boom', 5000));
    expect(await createTurnCommands(h.deps).stop()).toEqual({ ok: false, message: 'boom' });
    expect(h.deps.resumeStored).not.toHaveBeenCalled();
    expect(h.actions.at(-1)).toEqual({ type: 'stop.failed' });
  });
  it('a second tap while stopping sends nothing', async () => {
    const h = harness();
    h.setState('stopping');
    await createTurnCommands(h.deps).stop();
    expect(h.calls).toHaveLength(0);
  });
  it('no live session id → "尚未连接。" before dispatching stop.sent (F8)', async () => {
    const h = harness();
    h.deps.liveSessionId = () => null;
    const out = await createTurnCommands(h.deps).stop();
    expect(out).toEqual({ ok: false, message: '尚未连接。' });
    expect(h.actions).toEqual([]); // never entered 'stopping'
    expect(h.calls).toHaveLength(0);
    expect(h.timers).toHaveLength(0);
  });
  it('fallback fires a stop-timeout reconnect only if still stopping', async () => {
    const h = harness();
    const cmds = createTurnCommands(h.deps);
    await cmds.stop();
    h.timers[0].fn();
    expect(h.deps.reconnect).toHaveBeenCalledWith('stop-timeout');
    const h2 = harness();
    await createTurnCommands(h2.deps).stop();
    h2.setState('idle'); // message.complete{interrupted} arrived
    h2.timers[0].fn();
    expect(h2.deps.reconnect).not.toHaveBeenCalled();
  });
  it('after the stop-timeout reconnect, a turn still "stopping" re-enables Stop (never stuck on 正在停止…)', async () => {
    // A keeps `stopping` on resume.seeded{running:true} (A deviation 6), so if the interrupt never
    // landed the composer would otherwise stay disabled forever.
    const h = harness();
    await createTurnCommands(h.deps).stop();
    h.timers[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.actions.at(-1)).toEqual({ type: 'stop.failed' });
    const h2 = harness();
    await createTurnCommands(h2.deps).stop();
    (h2.deps.reconnect as jest.Mock).mockImplementationOnce(async () => h2.setState('idle')); // resume: not running
    h2.timers[0].fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(h2.actions).toEqual([{ type: 'stop.sent' }]);
  });
  it('a rejecting stop-timeout reconnect leaves no unhandled rejection, and stop.failed still dispatches (F7)', async () => {
    const h = harness();
    const onUnhandled = jest.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      (h.deps.reconnect as jest.Mock).mockImplementationOnce(async () => {
        throw new Error('offline');
      });
      await createTurnCommands(h.deps).stop();
      h.timers[0].fn();
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(h.actions.at(-1)).toEqual({ type: 'stop.failed' });
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
  it('a new stop cancels the previous timer; dispose cancels the current one', async () => {
    const h = harness();
    const cmds = createTurnCommands(h.deps);
    await cmds.stop();
    h.setState('streaming');
    await cmds.stop();
    expect(h.timers[0].cancelled).toBe(true);
    cmds.dispose();
    expect(h.timers[1].cancelled).toBe(true);
  });
});

describe('steer', () => {
  it('queued → steered, exactly one session.steer, no submit', async () => {
    const h = harness();
    h.reply('session.steer', { status: 'queued', text: 'use tabs' });
    expect(await createTurnCommands(h.deps).steer('use tabs')).toEqual({ kind: 'steered' });
    expect(h.calls).toEqual([{ method: 'session.steer', params: { session_id: 'live-1', text: 'use tabs' } }]);
  });
  it('rejected → prompt.submit with queued:true and submit.sent', async () => {
    const h = harness();
    h.reply('session.steer', { status: 'rejected', text: 'x' });
    expect(await createTurnCommands(h.deps).steer('x')).toEqual({ kind: 'submitted' });
    expect(h.calls[1]).toEqual({ method: 'prompt.submit', params: { session_id: 'live-1', text: 'x', queued: true } });
    expect(h.actions).toEqual([{ type: 'submit.sent' }]);
  });
  it('4010 (agent still building) → queued submit, never a plain submit', async () => {
    const h = harness();
    h.reply('session.steer', new RpcError('agent not ready', 4010));
    expect(await createTurnCommands(h.deps).steer('x')).toEqual({ kind: 'submitted' });
    expect(h.calls[1].params).toEqual({ session_id: 'live-1', text: 'x', queued: true });
  });
  it('4001 → resume and retry the steer once', async () => {
    const h = harness();
    h.reply('session.steer', new RpcError('stale', 4001), { status: 'queued', text: 'x' });
    expect(await createTurnCommands(h.deps).steer('x')).toEqual({ kind: 'steered' });
    expect(h.calls.map((c) => c.params)).toEqual([
      { session_id: 'live-1', text: 'x' },
      { session_id: 'live-2', text: 'x' },
    ]);
  });
  it('other errors → error outcome, no submit', async () => {
    const h = harness();
    h.reply('session.steer', new RpcError('failed', 5000));
    expect(await createTurnCommands(h.deps).steer('x')).toEqual({ kind: 'error', message: 'failed' });
    expect(h.calls).toHaveLength(1);
  });
  it('a failing fallback submit is an error outcome', async () => {
    const h = harness();
    h.reply('session.steer', { status: 'rejected', text: 'x' });
    h.reply('prompt.submit', new RpcError('slot limit', 4090));
    expect(await createTurnCommands(h.deps).steer('x')).toEqual({ kind: 'error', message: 'slot limit' });
  });
  describe('steer racing turn end (Review Focus 3)', () => {
    it('turn ends locally while the steer is in flight, server still queued it → steered, no submit', async () => {
      const h = harness();
      h.onCall.push((m) => m === 'session.steer' && h.setState('idle'));
      h.reply('session.steer', { status: 'queued', text: 'x' });
      expect(await createTurnCommands(h.deps).steer('x')).toEqual({ kind: 'steered' });
      expect(h.calls.map((c) => c.method)).toEqual(['session.steer']);
    });
    it('turn ended server-side → rejected → one queued submit that moves idle to waiting', async () => {
      const h = harness();
      h.onCall.push((m) => m === 'session.steer' && h.setState('idle'));
      h.reply('session.steer', { status: 'rejected', text: 'x' });
      await createTurnCommands(h.deps).steer('x');
      expect(h.calls.filter((c) => c.method === 'prompt.submit')).toHaveLength(1);
      expect(h.deps.turnState()).toBe('waiting');
    });
  });
});

describe('helpers', () => {
  it('restoreSteerText puts the failed text back without clobbering new typing', () => {
    expect(restoreSteerText('', 'use tabs')).toBe('use tabs');
    expect(restoreSteerText('  ', 'use tabs')).toBe('use tabs');
    expect(restoreSteerText('and spaces', 'use tabs')).toBe('use tabs\nand spaces');
  });
  it('completionEffects: Stopped marker on interrupted, success haptic only for live complete', () => {
    expect(completionEffects('interrupted', false)).toEqual({ stoppedMarker: true, successHaptic: false });
    expect(completionEffects('complete', false)).toEqual({ stoppedMarker: false, successHaptic: true });
    expect(completionEffects('complete', true)).toEqual({ stoppedMarker: false, successHaptic: false });
    expect(completionEffects('error', false)).toEqual({ stoppedMarker: false, successHaptic: false });
  });
});
