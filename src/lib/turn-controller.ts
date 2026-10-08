// src/lib/turn-controller.ts — pure turn-state + request-card reducer (spec §4.4, §5.1, §6.0;
// contract §3–§4). No React Native imports. Plan B adds composerMode() here.

export type TurnState = 'idle' | 'waiting' | 'streaming' | 'stopping';
export type CompleteStatus = 'complete' | 'error' | 'interrupted';

export type RequestKind = 'approval' | 'clarify' | 'secure-entry' | 'vault-declined';
export type RequestStatus = 'pending' | 'answering' | 'answered' | 'skipped' | 'cancelled';
export type CancelReason = 'interrupted' | 'timeout' | 'resolved' | 'session_closed' | 'shutdown';

export interface RequestCardState {
  id: string;
  kind: RequestKind;
  method: string;
  params: unknown;
  status: RequestStatus;
  cancelReason?: CancelReason;
  legacy: boolean;
  receivedAt: number;
  lockedAnswers?: Record<string, unknown>;
  anchorKey: string | null;
  /** Display-only outcome set on answer: the approval choice or a clarify summary.
   * NEVER a secret/sudo value. */
  resolution?: string;
}

export type RequestAction =
  | { type: 'request.received'; card: Omit<RequestCardState, 'status'> }
  | { type: 'request.answering'; id: string }
  | { type: 'request.answered'; id: string; skipped?: boolean; resolution?: string }
  | { type: 'request.failed'; id: string }
  | { type: 'request.locked'; id: string; qid: string; answer: unknown }
  | { type: 'request.cancelled'; id: string; reason: CancelReason };

export interface TurnModel {
  turn: TurnState;
  lastStatus: CompleteStatus | null;
  requests: RequestCardState[];
}

export type TurnAction =
  | { type: 'submit.sent' }
  | { type: 'event.message.start'; replayed: boolean }
  | { type: 'event.message.complete'; status: CompleteStatus; replayed: boolean }
  | { type: 'event.error'; replayed: boolean }
  | { type: 'stop.sent' }
  | { type: 'stop.failed' }
  /** `openRequestIds` (additive): ids this same resume re-delivered via `open_requests`. The
   * channel delivers them BEFORE the resume resolves, so they are already pending again here. */
  | { type: 'resume.seeded'; running: boolean; openRequestIds?: readonly string[] }
  | { type: 'socket.lost' }
  | RequestAction;

export function initialTurnModel(): TurnModel {
  return { turn: 'idle', lastStatus: null, requests: [] };
}

const OPEN: ReadonlySet<RequestStatus> = new Set(['pending', 'answering']);

/** Close still-open LEGACY (0.20.4) approval cards: the old gateway force-denies them at turn
 * end and they cannot be answered across a dead socket. 0.21.5 cards close on request.cancel. */
function closeLegacy(requests: RequestCardState[], reason: CancelReason): RequestCardState[] {
  if (!requests.some((r) => r.legacy && OPEN.has(r.status))) return requests;
  return requests.map((r) =>
    r.legacy && OPEN.has(r.status) ? { ...r, status: 'cancelled', cancelReason: reason } : r,
  );
}

/** `resume.seeded{running:false}`: no server request can be open on an idle session (0.21.5's
 * live status is 'waiting' while any prompt is pending, and that seeds running), so every open
 * 0.21.5 card was withdrawn while the socket was down (review I2). Cards re-delivered by this
 * same resume stay open; legacy cards are socket.lost's job; settled cards keep their outcome. */
function closeWithdrawn(requests: RequestCardState[], keep: readonly string[] = []): RequestCardState[] {
  const withdrawn = (r: RequestCardState) => !r.legacy && OPEN.has(r.status) && !keep.includes(r.id);
  if (!requests.some(withdrawn)) return requests;
  return requests.map((r) => (withdrawn(r) ? { ...r, status: 'cancelled', cancelReason: 'session_closed' } : r));
}

function mapCard(
  requests: RequestCardState[],
  id: string,
  fn: (r: RequestCardState) => RequestCardState,
): RequestCardState[] {
  const idx = requests.findIndex((r) => r.id === id);
  if (idx < 0) return requests;
  const next = fn(requests[idx]);
  if (next === requests[idx]) return requests;
  const out = [...requests];
  out[idx] = next;
  return out;
}

/** Clarify batch replay carries already-locked answers as `params.answers` ({qid: str}). */
function paramAnswers(params: unknown): Record<string, unknown> | undefined {
  const a = (params as { answers?: unknown } | null | undefined)?.answers;
  return a && typeof a === 'object' && !Array.isArray(a) ? (a as Record<string, unknown>) : undefined;
}

function mergeLocked(...parts: (Record<string, unknown> | undefined)[]): Record<string, unknown> | undefined {
  const present = parts.filter((p): p is Record<string, unknown> => p !== undefined);
  return present.length ? Object.assign({}, ...present) : undefined;
}

function reduceRequests(requests: RequestCardState[], a: RequestAction): RequestCardState[] {
  switch (a.type) {
    case 'request.received': {
      const idx = requests.findIndex((r) => r.id === a.card.id);
      const incoming = mergeLocked(a.card.lockedAnswers, paramAnswers(a.card.params));
      if (idx < 0) return [...requests, { ...a.card, lockedAnswers: incoming, status: 'pending' }];
      // Re-delivery (open_requests replay) = the server says it is still open: update in
      // place, keep position (anchorKey) and the original receivedAt, re-arm as pending,
      // clear cancelReason/resolution, merge replayed answers into lockedAnswers (contract D2).
      const prev = requests[idx];
      const out = [...requests];
      out[idx] = {
        ...prev,
        kind: a.card.kind,
        method: a.card.method,
        params: a.card.params,
        legacy: a.card.legacy,
        status: 'pending',
        cancelReason: undefined,
        resolution: undefined,
        lockedAnswers: mergeLocked(prev.lockedAnswers, incoming),
      };
      return out;
    }
    case 'request.answering':
      return mapCard(requests, a.id, (r) => (r.status === 'pending' ? { ...r, status: 'answering' } : r));
    case 'request.answered':
      return mapCard(requests, a.id, (r) =>
        OPEN.has(r.status)
          ? {
              ...r,
              status: a.skipped ? 'skipped' : 'answered',
              ...(a.resolution !== undefined ? { resolution: a.resolution } : {}),
            }
          : r,
      );
    case 'request.failed':
      return mapCard(requests, a.id, (r) => (r.status === 'answering' ? { ...r, status: 'pending' } : r));
    case 'request.locked':
      return mapCard(requests, a.id, (r) => ({
        ...r,
        lockedAnswers: { ...r.lockedAnswers, [a.qid]: a.answer },
      }));
    case 'request.cancelled':
      return mapCard(requests, a.id, (r) =>
        OPEN.has(r.status) ? { ...r, status: 'cancelled', cancelReason: a.reason } : r,
      );
  }
}

export function reduceTurn(model: TurnModel, action: TurnAction): TurnModel {
  switch (action.type) {
    case 'submit.sent':
      return model.turn === 'idle' ? { ...model, turn: 'waiting', lastStatus: null } : model;
    case 'event.message.start':
      return { ...model, turn: 'streaming', lastStatus: null };
    case 'event.message.complete':
      return {
        ...model,
        turn: 'idle',
        lastStatus: action.status,
        requests: closeLegacy(model.requests, action.status === 'interrupted' ? 'interrupted' : 'session_closed'),
      };
    case 'event.error':
      // Before message.start an error means no message.complete will follow (review M6).
      return model.turn === 'waiting' ? { ...model, turn: 'idle', lastStatus: 'error' } : model;
    case 'stop.sent':
      return model.turn === 'waiting' || model.turn === 'streaming' ? { ...model, turn: 'stopping' } : model;
    case 'stop.failed':
      return model.turn === 'stopping' ? { ...model, turn: 'streaming' } : model;
    case 'resume.seeded':
      if (!action.running) {
        return { ...model, turn: 'idle', requests: closeWithdrawn(model.requests, action.openRequestIds) };
      }
      // A Stop already in flight stays 'stopping' until message.complete arrives.
      return { ...model, turn: model.turn === 'stopping' ? 'stopping' : 'streaming' };
    case 'socket.lost':
      return { ...model, requests: closeLegacy(model.requests, 'session_closed') };
    default: {
      const requests = reduceRequests(model.requests, action);
      return requests === model.requests ? model : { ...model, requests };
    }
  }
}

/** Haptics and one-shot UI fire only for live (non-replayed) events (spec §5.1, review m16). */
export function shouldFireSideEffects(action: TurnAction): boolean {
  return !('replayed' in action && action.replayed);
}

// ── event → action mapping ──

export function completeStatus(payload: unknown): CompleteStatus {
  const s = (payload as { status?: unknown } | null | undefined)?.status;
  return s === 'error' || s === 'interrupted' ? s : 'complete';
}

/** The turn-state action a gateway event implies, or null. */
export function turnActionFor(e: { type: string; payload?: unknown; replayed?: boolean }): TurnAction | null {
  const replayed = e.replayed === true;
  switch (e.type) {
    case 'message.start':
      return { type: 'event.message.start', replayed };
    case 'message.complete':
      return { type: 'event.message.complete', status: completeStatus(e.payload), replayed };
    case 'error':
      return { type: 'event.error', replayed };
    default:
      return null;
  }
}

/** Is a turn running, per a `session.resume` result (0.21.5 `running`/`status`, both tags `inflight`)? */
export function resumeRunning(res: {
  running?: boolean | null;
  status?: string | null;
  inflight?: { streaming?: boolean } | null;
}): boolean {
  return (
    res.running === true ||
    res.status === 'working' ||
    res.status === 'streaming' ||
    res.status === 'waiting' ||
    res.status === 'starting' ||
    res.status === 'resuming' ||
    (res.status !== 'idle' && res.inflight?.streaming === true)
  );
}

// ── request helpers ──

const VAULT = new Set(['vault.unlock_prompt', 'vault.save_login', 'vault.code']);

/** null ⇒ not mobile-supported: the handler declines and the channel answers -32601. */
export function kindForMethod(method: string): RequestKind | null {
  if (method === 'approval') return 'approval';
  if (method === 'clarify') return 'clarify';
  if (method === 'sudo' || method === 'secret') return 'secure-entry';
  if (VAULT.has(method)) return 'vault-declined';
  return null;
}

const LABELS: Record<CancelReason, string> = {
  interrupted: '已停止',
  timeout: '已超时',
  resolved: '已在其他设备回答',
  session_closed: '已关闭',
  shutdown: '已关闭',
};

export function cancelLabel(reason: CancelReason): string {
  return LABELS[reason];
}

/** Wire `request.cancel.reason` is a plain string; unknown values read as "Closed". */
export function toCancelReason(raw: unknown): CancelReason {
  return typeof raw === 'string' && raw in LABELS ? (raw as CancelReason) : 'session_closed';
}

/** Transcript rows with request cards merged in after their anchor item (cards live
 * outside `items`, so a history replace cannot drop them — spec §6.0, review B1.3). */
export type TranscriptRow<T> = { kind: 'item'; item: T } | { kind: 'request'; card: RequestCardState };

export function mergeRequestRows<T extends { key: string }>(
  items: T[],
  requests: RequestCardState[],
): TranscriptRow<T>[] {
  const byAnchor = new Map<string, RequestCardState[]>();
  const head: RequestCardState[] = [];
  const tail: RequestCardState[] = [];
  const keys = new Set(items.map((i) => i.key));
  for (const r of requests) {
    if (r.anchorKey !== null && keys.has(r.anchorKey)) {
      const list = byAnchor.get(r.anchorKey) ?? [];
      list.push(r);
      byAnchor.set(r.anchorKey, list);
    } else if (r.anchorKey === null) {
      // anchorKey === null means the card arrived before any transcript item existed: a settled
      // one renders at the head (chronologically first); an open one stays visible at the tail,
      // same as any other orphan, so it doesn't get buried above newer history.
      (OPEN.has(r.status) ? tail : head).push(r);
    } else if (OPEN.has(r.status)) {
      // Orphaned by a history replace (its anchor item is gone): open cards stay visible at the
      // end; settled ones are already reflected in the reloaded history, so they are not
      // re-rendered out of place.
      tail.push(r);
    }
  }
  const rows: TranscriptRow<T>[] = [];
  for (const card of head) rows.push({ kind: 'request', card });
  for (const item of items) {
    rows.push({ kind: 'item', item });
    for (const card of byAnchor.get(item.key) ?? []) rows.push({ kind: 'request', card });
  }
  for (const card of tail) rows.push({ kind: 'request', card });
  return rows;
}

// ── Plan B: composer selectors and request-card semantics ───────────────────────────────────

export type ComposerMode =
  | { kind: 'send'; enabled: boolean } // idle
  | { kind: 'stop+steer'; stopEnabled: boolean; steerEnabled: boolean }; // waiting/streaming/stopping

/** Spec §5.2. Images are not steerable, so steer needs text; a staged photo waits for idle. */
export function composerMode(model: TurnModel, hasText: boolean, hasImage: boolean): ComposerMode {
  switch (model.turn) {
    case 'idle':
      return { kind: 'send', enabled: hasText || hasImage };
    case 'waiting':
    case 'streaming':
      return { kind: 'stop+steer', stopEnabled: true, steerEnabled: hasText };
    case 'stopping':
      return { kind: 'stop+steer', stopEnabled: false, steerEnabled: false };
  }
}

/** 0.21.5 approvals resolve per request id (all actionable). Legacy approvals resolve the OLDEST
 *  pending one server-side, so only the oldest unresolved legacy card is actionable (spec §6.1). */
export function isApprovalActionable(requests: RequestCardState[], id: string): boolean {
  const card = requests.find((r) => r.id === id);
  if (!card || card.kind !== 'approval' || card.status !== 'pending') return false;
  if (!card.legacy) return true;
  const oldest = requests.find(
    (r) => r.kind === 'approval' && r.legacy && (r.status === 'pending' || r.status === 'answering'),
  );
  return oldest?.id === id;
}
