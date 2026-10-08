// src/lib/secure-entry.ts — copy, countdown and provenance for sudo/secret cards (spec §6.4).
// Nothing here ever sees the typed value.
import type { SkillInfo } from '@/api/skills';
import type { RequestCardState } from '@/lib/turn-controller';
import type { SecretRequestParams, SudoRequestParams } from '@/vendor/hermes-gateway';

export const SECURE_ENTRY_TIMEOUT_S = { secret: 300, sudo: 120 } as const;
export type SecureMethod = keyof typeof SECURE_ENTRY_TIMEOUT_S;
export type ProvenanceLabel = NonNullable<SkillInfo['provenance']> | 'unknown';

export function secondsRemaining(method: SecureMethod, receivedAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil(SECURE_ENTRY_TIMEOUT_S[method] - (nowMs - receivedAt) / 1000));
}

export function formatCountdown(s: number): string {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function countdownA11y(s: number): string {
  const m = Math.floor(s / 60);
  const r = s % 60;
  const parts = [m ? `${m} 分钟` : '', r ? `${r} 秒` : ''].filter(Boolean);
  return `剩余 ${parts.join(' ') || '0 秒'}`;
}

/** A request's params as a record of unknowns: server data is never trusted to match its type (m3). */
function fields<T>(params: unknown): Partial<Record<keyof T, unknown>> {
  return typeof params === 'object' && params !== null ? (params as Partial<Record<keyof T, unknown>>) : {};
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

export function skillNameOf(params: unknown): string | null {
  const meta = fields<SecretRequestParams>(params).metadata;
  const n = typeof meta === 'object' && meta !== null ? (meta as Record<string, unknown>).skill_name : undefined;
  return typeof n === 'string' && n.trim() ? n.trim() : null;
}

export function provenanceFor(skills: SkillInfo[] | null, skillName: string | null): ProvenanceLabel {
  if (!skills || !skillName) return 'unknown';
  return skills.find((s) => s.name === skillName)?.provenance ?? 'unknown';
}

/** The latest skills lookup: the pending secret-card ids it was made for, and its result (null = failed). */
export interface SkillsLookup {
  ids: string[];
  list: SkillInfo[] | null;
}

/**
 * Provenance for one secret card, or null while its lookup is in flight ("checking…"). A lookup
 * covers the cards it was made for, so a newer card arriving never resets an older one. A settled
 * card has no lookup of its own coming: it uses the last result, or "unknown" if there never was one.
 */
export function provenanceForCard(card: RequestCardState, lookup: SkillsLookup | null): ProvenanceLabel | null {
  const covered = lookup !== null && lookup.ids.includes(card.id);
  if (!covered && card.status === 'pending') return null;
  return provenanceFor(lookup?.list ?? null, skillNameOf(card.params));
}

export function provenanceText(p: ProvenanceLabel): string {
  return { hub: 'Skills Hub', bundled: 'Hermes 内置', agent: '由智能体编写', unknown: '未知' }[p];
}

export interface SecureEntryCopy {
  method: SecureMethod;
  title: string;
  ask: string | null;
  command: string | null;
  textContentType: 'password' | 'none';
  warning: string | null;
  destination: string | null;
  skillName: string | null;
  fieldLabel: string;
  placeholder: string;
  authReason: string;
}

/**
 * The card's copy, or null when it can't be shown (final review m3): a secret without a usable
 * `env_var` — the value's destination is the one fact the card must state. Sudo needs no params.
 */
export function secureEntryCopy(card: RequestCardState): SecureEntryCopy | null {
  if (card.method === 'sudo') {
    const p = fields<SudoRequestParams>(card.params);
    return {
      method: 'sudo', title: '管理员密码', ask: null, command: text(p.command),
      textContentType: 'password', warning: null, destination: null, skillName: null,
      fieldLabel: '管理员密码', placeholder: '密码',
      authReason: '将管理员密码发送给 Hermes',
    };
  }
  const p = fields<SecretRequestParams>(card.params);
  const envVar = text(p.env_var)?.trim();
  if (!envVar) return null;
  return {
    method: 'secret',
    title: `输入 ${envVar}`,
    ask: text(p.prompt),
    command: null,
    textContentType: 'none', // never offer to save an API key to Passwords (review m14)
    warning: '仅在你主动要求此操作时继续。智能体可以编写或修改发起请求的技能。',
    destination: '内容将保存到网关的 .env 文件，智能体可以读取。',
    skillName: skillNameOf(card.params),
    fieldLabel: `输入 ${envVar}`,
    placeholder: '粘贴或输入内容',
    authReason: `发送 ${envVar} 给 Hermes`,
  };
}
