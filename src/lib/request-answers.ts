// src/lib/request-answers.ts
//
// Answering server→client requests (spec §6). Pure with injected I/O. Cards answer optimistically:
// 0.21.5 sends no ack for a response frame (review M10). Secret values pass straight through to
// `registry.respond` and are NEVER put into a dispatched action.
import type { GatewayClient } from '@/api/gatewayClient';
import { resolvedCount } from '@/lib/approval';
import type { RequestRegistry } from '@/lib/request-registry';
import type { RequestCardState, TurnAction } from '@/lib/turn-controller';
import type { ApprovalResult, ClarifyResult, ValueResult } from '@/vendor/hermes-gateway';

export function approvalResult(choice: ApprovalResult['choice']): ApprovalResult {
  return { choice };
}
export function clarifySingleResult(answer: string): ClarifyResult {
  return { answer };
}
export function clarifySkipAllResult(): ClarifyResult {
  return {};
}
export function valueResult(value: string): ValueResult {
  return { value };
}

export type ClarifyAnswer = string | string[];
export type AnswerOutcome = { ok: true } | { ok: false; message: string };
/** `resolved`: the last lock resolved the whole batch. `expired`: the wait already ended. */
export type LockOutcome = 'ok' | 'resolved' | 'expired' | 'failed';

export interface ResponderDeps {
  /** `drop` is used only when `clarify.lock` resolves the whole batch: that path never goes
   * through `respond` (no response frame is sent), so nothing else removes the registry entry
   * (Preflight F11 — symmetry with the router's `request.cancel` handling). */
  registry: Pick<RequestRegistry, 'respond' | 'drop'>;
  call: GatewayClient['call'];
  dispatch: (a: TurnAction) => void;
  liveSessionId: () => string | null;
  /** The card as the turn store holds it NOW. A second press can still hold the card from an older
   *  render (still `pending`), so every answer guards on this, never on the card it was handed (m1). */
  current: (id: string) => RequestCardState | undefined;
}

export interface RequestResponder {
  approve(card: RequestCardState, choice: ApprovalResult['choice']): Promise<AnswerOutcome>;
  clarifySingle(card: RequestCardState, answer: ClarifyAnswer): AnswerOutcome;
  clarifyLock(card: RequestCardState, qid: string, answer: ClarifyAnswer): Promise<LockOutcome>;
  clarifySubmitAll(card: RequestCardState, answers: { qid: string; answer: ClarifyAnswer }[]): Promise<LockOutcome>;
  clarifySkipAll(card: RequestCardState): AnswerOutcome;
  value(card: RequestCardState, value: string): AnswerOutcome;
}

const GONE: AnswerOutcome = { ok: false, message: '此请求已关闭。' };

function summary(answer: ClarifyAnswer): string {
  return Array.isArray(answer) ? answer.join(', ') : answer;
}

export function createRequestResponder(deps: ResponderDeps): RequestResponder {
  /** Still answerable per the store: a card gone from it, answering, or settled is not (m1). */
  const isPending = (card: RequestCardState) => deps.current(card.id)?.status === 'pending';

  /** Response frame via the latest delivery of this id; an unknown id means it's gone. */
  function respond(card: RequestCardState, result: Record<string, unknown>): boolean {
    if (deps.registry.respond(card.id, result)) return true;
    deps.dispatch({ type: 'request.cancelled', id: card.id, reason: 'session_closed' });
    return false;
  }

  async function lock(card: RequestCardState, qid: string, answer: ClarifyAnswer): Promise<LockOutcome> {
    try {
      const res = await deps.call('clarify.lock', { request_id: card.id, question_id: qid, answer });
      if (res.status === 'expired') {
        deps.dispatch({ type: 'request.cancelled', id: card.id, reason: 'timeout' });
        return 'expired';
      }
      deps.dispatch({ type: 'request.locked', id: card.id, qid, answer });
      if (Array.isArray(res.remaining) && res.remaining.length === 0) {
        // The server closed the request; no response frame follows on this path (unlike
        // approve/clarifySingle/clarifySkipAll/value, which route through `respond`), so drop
        // the registry entry ourselves — symmetric with the router's request.cancel handling.
        deps.dispatch({ type: 'request.answered', id: card.id });
        deps.registry.drop(card.id);
        return 'resolved';
      }
      return 'ok';
    } catch {
      return 'failed';
    }
  }

  return {
    async approve(card, choice) {
      if (!isPending(card)) return { ok: true };
      if (!card.legacy) {
        if (!respond(card, { ...approvalResult(choice) })) return GONE;
        deps.dispatch({ type: 'request.answered', id: card.id, resolution: choice });
        return { ok: true };
      }
      const sid = deps.liveSessionId();
      if (!sid) return { ok: false, message: '尚未连接。' };
      deps.dispatch({ type: 'request.answering', id: card.id });
      try {
        const res = await deps.call('approval.respond', { session_id: sid, choice });
        if (resolvedCount(res) > 0) deps.dispatch({ type: 'request.answered', id: card.id, resolution: choice });
        else deps.dispatch({ type: 'request.cancelled', id: card.id, reason: 'resolved' });
        return { ok: true };
      } catch (e) {
        deps.dispatch({ type: 'request.failed', id: card.id });
        return { ok: false, message: e instanceof Error && e.message ? e.message : '授权失败。' };
      }
    },

    clarifySingle(card, answer) {
      if (!isPending(card)) return { ok: true };
      // ClarifyResult.answer is a string; the gateway parses a JSON array for multi-select.
      const wire = Array.isArray(answer) ? JSON.stringify(answer) : answer;
      if (!respond(card, { ...clarifySingleResult(wire) })) return GONE;
      deps.dispatch({ type: 'request.answered', id: card.id, skipped: wire === '', resolution: summary(answer) });
      return { ok: true };
    },

    async clarifyLock(card, qid, answer) {
      if (!isPending(card)) return 'failed';
      return lock(card, qid, answer);
    },

    async clarifySubmitAll(card, answers) {
      if (!isPending(card)) return 'failed';
      deps.dispatch({ type: 'request.answering', id: card.id });
      for (const { qid, answer } of answers) {
        const out = await lock(card, qid, answer);
        if (out === 'resolved' || out === 'expired') return out;
        if (out === 'failed') {
          deps.dispatch({ type: 'request.failed', id: card.id });
          return 'failed';
        }
      }
      // Every question we know of is locked but the gateway still lists some open: stay answerable.
      deps.dispatch({ type: 'request.failed', id: card.id });
      return 'ok';
    },

    clarifySkipAll(card) {
      if (!isPending(card)) return { ok: true };
      if (!respond(card, { ...clarifySkipAllResult() })) return GONE;
      deps.dispatch({ type: 'request.answered', id: card.id, skipped: true });
      return { ok: true };
    },

    value(card, value) {
      if (!isPending(card)) return { ok: true };
      if (!respond(card, { ...valueResult(value) })) return GONE;
      deps.dispatch({ type: 'request.answered', id: card.id, skipped: value === '' });
      return { ok: true };
    },
  };
}
