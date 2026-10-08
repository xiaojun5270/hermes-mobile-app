import {
  composerMode,
  initialTurnModel,
  isApprovalActionable,
  reduceTurn,
  type RequestCardState,
  type TurnModel,
} from '../turn-controller';

type NewCard = Omit<RequestCardState, 'status'>;
function card(over: Partial<NewCard> & { id: string }): NewCard {
  return {
    kind: 'approval',
    method: 'approval',
    params: { session_id: 's1', request_id: 'r1', command: 'rm -rf build' },
    legacy: false,
    receivedAt: 1000,
    anchorKey: null,
    ...over,
  };
}
const at = (turn: TurnModel['turn']): TurnModel => ({ ...initialTurnModel(), turn });
const recv = (m: TurnModel, c: NewCard) => reduceTurn(m, { type: 'request.received', card: c });

describe('composerMode', () => {
  it('idle: send, enabled by text or by a staged photo alone (review m9)', () => {
    expect(composerMode(at('idle'), false, false)).toEqual({ kind: 'send', enabled: false });
    expect(composerMode(at('idle'), true, false)).toEqual({ kind: 'send', enabled: true });
    expect(composerMode(at('idle'), false, true)).toEqual({ kind: 'send', enabled: true });
  });
  it('waiting/streaming: Stop always; steer only with text (images are not steerable)', () => {
    for (const t of ['waiting', 'streaming'] as const) {
      expect(composerMode(at(t), false, false)).toEqual({ kind: 'stop+steer', stopEnabled: true, steerEnabled: false });
      expect(composerMode(at(t), true, true)).toEqual({ kind: 'stop+steer', stopEnabled: true, steerEnabled: true });
      expect(composerMode(at(t), false, true)).toEqual({ kind: 'stop+steer', stopEnabled: true, steerEnabled: false });
    }
  });
  it('stopping: Stop and steer disabled', () => {
    expect(composerMode(at('stopping'), true, false)).toEqual({ kind: 'stop+steer', stopEnabled: false, steerEnabled: false });
  });
});

describe('is操作授权Actionable', () => {
  it('0.21.5 approvals are independently actionable', () => {
    let m = recv(initialTurnModel(), card({ id: 'srq-a' }));
    m = recv(m, card({ id: 'srq-b' }));
    expect(isApprovalActionable(m.requests, 'srq-a')).toBe(true);
    expect(isApprovalActionable(m.requests, 'srq-b')).toBe(true);
  });
  it('legacy approvals are FIFO: only the oldest unresolved legacy card', () => {
    let m = recv(initialTurnModel(), card({ id: 'legacy:1', legacy: true }));
    m = recv(m, card({ id: 'legacy:2', legacy: true }));
    expect(isApprovalActionable(m.requests, 'legacy:1')).toBe(true);
    expect(isApprovalActionable(m.requests, 'legacy:2')).toBe(false);
    m = reduceTurn(m, { type: 'request.answered', id: 'legacy:1', resolution: 'deny' });
    expect(isApprovalActionable(m.requests, 'legacy:2')).toBe(true);
  });
  it('settled, unknown and non-approval cards are never actionable', () => {
    let m = recv(initialTurnModel(), card({ id: 'srq-a' }));
    m = reduceTurn(m, { type: 'request.cancelled', id: 'srq-a', reason: 'timeout' });
    m = recv(m, card({ id: 'srq-c', kind: 'clarify', method: 'clarify', params: { session_id: 's1', question: 'q?' } }));
    expect(isApprovalActionable(m.requests, 'srq-a')).toBe(false);
    expect(isApprovalActionable(m.requests, 'srq-c')).toBe(false);
    expect(isApprovalActionable(m.requests, 'nope')).toBe(false);
  });
});

// Request re-delivery/resolution (D1/D2: re-arm as pending, keep receivedAt/anchorKey, clear
// cancelReason/resolution, merge params.answers, skipped) is pinned by Plan A's own suite —
// see src/lib/__tests__/turn-controller.test.ts:94-134. Not duplicated here (Preflight F5).
