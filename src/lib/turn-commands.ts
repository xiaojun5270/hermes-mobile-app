// src/lib/turn-commands.ts
//
// Stop and steer decisions (spec §5.3), pure with injected I/O. The chat screen supplies the
// gateway call, the turn dispatch and the reconnect trigger; nothing here touches React.
import { RpcError, type GatewayClient } from '@/api/gatewayClient';
import { withStaleSessionRetry } from '@/api/stale-session'; // A: the one 4001 rule (resume + retry once)
import type { CompleteStatus, TurnAction, TurnState } from './turn-controller';

export const AGENT_BUILDING_CODE = 4010; // steer while the agent is still being built
export const STOP_FALLBACK_MS = 15_000;

export interface TurnCommandDeps {
  call: GatewayClient['call'];
  dispatch: (a: TurnAction) => void;
  liveSessionId: () => string | null;
  turnState: () => TurnState;
  /** A's `ChatTransport.resumeStored()`: `session.resume` on the stored id over the current socket;
   *  updates the live id + seeds the store; resolves the fresh live id. */
  resumeStored: () => Promise<string>;
  reconnect: (trigger: 'stop-timeout') => Promise<void>;
  /** setTimeout wrapper returning a canceller (injected for tests). */
  setTimer: (fn: () => void, ms: number) => () => void;
}

export type StopOutcome = { ok: true } | { ok: false; message: string };
export type SteerOutcome = { kind: 'steered' } | { kind: 'submitted' } | { kind: 'error'; message: string };

export interface TurnCommands {
  stop(): Promise<StopOutcome>;
  steer(text: string): Promise<SteerOutcome>;
  dispose(): void;
}

function messageOf(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

/** Failed steer: its text goes back in the input, ahead of anything typed since. */
export function restoreSteerText(current: string, failed: string): string {
  return current.trim() ? `${failed}\n${current}` : failed;
}

/** `message.complete` side effects: "Stopped" marker on interrupt; success haptic only for a live
 *  (non-replayed) normal completion (spec §5.1, review m16). `status` is A's `CompleteStatus`,
 *  never null — `completeStatus()` always resolves to a concrete status (F9). */
export function completionEffects(
  status: CompleteStatus,
  replayed: boolean,
): { stoppedMarker: boolean; successHaptic: boolean } {
  return { stoppedMarker: status === 'interrupted', successHaptic: status === 'complete' && !replayed };
}

export function createTurnCommands(deps: TurnCommandDeps): TurnCommands {
  let cancelFallback: (() => void) | null = null;
  const clearFallback = () => {
    cancelFallback?.();
    cancelFallback = null;
  };

  function liveId(): string {
    const id = deps.liveSessionId();
    if (!id) throw new Error('尚未连接。');
    return id;
  }

  /** Run `op` on the live id; a 4001 resumes the stored id and retries ONCE on the fresh id (A's rule). */
  function onLiveSession<T>(op: (sid: string) => Promise<T>): Promise<T> {
    return withStaleSessionRetry(liveId(), op, deps.resumeStored);
  }

  async function submitQueued(text: string): Promise<void> {
    await onLiveSession((sid) => deps.call('prompt.submit', { session_id: sid, text, queued: true }));
    deps.dispatch({ type: 'submit.sent' });
  }

  async function stop(): Promise<StopOutcome> {
    const state = deps.turnState();
    if (state !== 'waiting' && state !== 'streaming') return { ok: true };
    // F8: check connectivity BEFORE dispatching stop.sent — an id-less stop must never move the
    // turn into 'stopping' (there would be nothing to time out, and Stop would look stuck).
    const sid = deps.liveSessionId();
    if (!sid) return { ok: false, message: '尚未连接。' };
    deps.dispatch({ type: 'stop.sent' });
    try {
      // The result is ignored: it reports "interrupted" even for an idle session.
      await withStaleSessionRetry(sid, (id) => deps.call('session.interrupt', { session_id: id }), deps.resumeStored);
    } catch (e) {
      deps.dispatch({ type: 'stop.failed' });
      return { ok: false, message: messageOf(e, '无法停止回复。') };
    }
    clearFallback();
    cancelFallback = deps.setTimer(() => {
      cancelFallback = null;
      if (deps.turnState() !== 'stopping') return;
      void (async () => {
        try {
          await deps.reconnect('stop-timeout');
        } catch {
          // F7: swallow — reconnect's own failure doesn't change what happens next; we still run
          // the stuck-'stopping' check below so this never leaves an unhandled rejection.
        } finally {
          // The reconnect re-seeds from session.resume. A keeps `stopping` while the server still
          // reports the turn running (A deviation 6), so re-enable Stop rather than leave it stuck.
          if (deps.turnState() === 'stopping') deps.dispatch({ type: 'stop.failed' });
        }
      })();
    }, STOP_FALLBACK_MS);
    return { ok: true };
  }

  async function steer(text: string): Promise<SteerOutcome> {
    let status: string;
    try {
      const res = await onLiveSession((sid) => deps.call('session.steer', { session_id: sid, text }));
      status = res.status;
    } catch (e) {
      if (!(e instanceof RpcError) || e.code !== AGENT_BUILDING_CODE) {
        return { kind: 'error', message: messageOf(e, '无法发送引导。') };
      }
      status = 'rejected'; // agent still building: queue it (a plain submit would hard-interrupt)
    }
    if (status !== 'rejected') return { kind: 'steered' };
    try {
      await submitQueued(text);
      return { kind: 'submitted' };
    } catch (e) {
      return { kind: 'error', message: messageOf(e, '无法发送。') };
    }
  }

  return { stop, steer, dispose: clearFallback };
}
