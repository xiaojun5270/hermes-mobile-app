export interface SessionReadiness {
  running?: boolean | null;
  status?: string | null;
  inflight?: { streaming?: boolean } | null;
}

const ACTIVE = new Set(['working', 'streaming', 'waiting', 'starting', 'resuming']);

/** Explicit session state outranks retained turn history; missing state proves nothing. */
export function sessionReadiness(s: SessionReadiness): 'idle' | 'busy' | 'unknown' {
  if (s.running === true || (s.status && ACTIVE.has(s.status))) return 'busy';
  if (s.status === 'idle') return 'idle';
  if (s.running === false && !s.inflight?.streaming) return 'idle';
  if (s.inflight?.streaming) return 'busy';
  return 'unknown';
}
