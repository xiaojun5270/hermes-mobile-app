// src/lib/mcp.ts — pure logic for the Connectors screens (spec §5, §8). No I/O.
import { McpAlreadyAddedError, McpPreflightError, type McpCatalogEntry, type McpServer } from '@/api/mcp';
import type { McpRuntimeRow, McpTestOutcome } from '@/api/mcpSession';
import { AuthError, HttpError } from '@/api/restClient';

// --- catalog ---------------------------------------------------------------

/** Entries the app can add: remote, with no local install step. Sorted by name. */
export function remoteCatalogEntries(entries: McpCatalogEntry[]): McpCatalogEntry[] {
  return entries
    .filter((e) => e.transport === 'http' && !e.needs_install)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Case-insensitive substring match over name and description. */
export function filterCatalog(entries: McpCatalogEntry[], query: string): McpCatalogEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) => e.name.toLowerCase().includes(q) || (e.description ?? '').toLowerCase().includes(q),
  );
}

// --- custom server form ----------------------------------------------------

const SKIPPED_LABELS = new Set(['www', 'mcp', 'api']);

/** A name suggestion from the URL's host: `https://mcp.linear.app/mcp` → `linear`. '' when there is none. */
export function suggestServerName(url: string): string {
  let host: string;
  try {
    host = new URL(url.trim()).hostname.toLowerCase();
  } catch {
    return '';
  }
  if (!host || /^[\d.]+$/.test(host) || host.includes(':')) return '';
  const labels = host.split('.').filter(Boolean);
  const body = labels.length > 1 ? labels.slice(0, -1) : labels;
  const pick = body.find((l) => !SKIPPED_LABELS.has(l)) ?? body[0] ?? '';
  return pick.replace(/[^a-z0-9_-]/g, '-');
}

export interface CustomServerDraft {
  name: string;
  url: string;
  auth: 'none' | 'header' | 'oauth';
  /** Whether a token has been typed. The token itself never reaches this module. */
  hasToken: boolean;
}

export interface CustomServerIssues {
  name?: string;
  url?: string;
  token?: string;
  /** Not an error: shown under the URL field. */
  caution?: string;
}

/** Client-side checks before any request; the gateway does the real validation. */
export function validateCustomServer(draft: CustomServerDraft): CustomServerIssues {
  const issues: CustomServerIssues = {};
  const name = draft.name.trim();
  if (!name) issues.name = '请输入名称。';
  else if (/[\s/]/.test(name)) issues.name = '名称不能包含空格或斜杠。';

  const url = draft.url.trim();
  if (!url) {
    issues.url = '请输入服务器地址。';
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    const protocol = parsed?.protocol ?? '';
    if (protocol !== 'http:' && protocol !== 'https:') {
      issues.url = '请输入以 https:// 开头的地址。';
    } else if (parsed) {
      const cautions: string[] = [];
      if (protocol === 'http:') cautions.push('网关与此服务器之间的通信不会加密。');
      // The URL is not typed into the secret form: it is kept as written and shown on the connector.
      if (parsed.search || parsed.username || parsed.password) {
        cautions.push('此地址包含密钥或凭据，将原样保存在网关并显示在应用中。');
      }
      if (cautions.length > 0) issues.caution = cautions.join(' ');
    }
  }

  if (draft.auth === 'header' && !draft.hasToken) issues.token = '请输入令牌。';
  return issues;
}

export function isCustomServerValid(issues: CustomServerIssues): boolean {
  return !issues.name && !issues.url && !issues.token;
}

// --- what a server allows (spec §5.3) --------------------------------------

export interface ServerCapabilities {
  /** False when the REST routes cannot address the name (it contains '/'). */
  manageable: boolean;
  canSwitch: boolean;
  canTest: boolean;
  /** Test runs when the detail screen opens (remote servers only). */
  autoTest: boolean;
  canSignIn: boolean;
  canRemove: boolean;
}

export function serverCapabilities(server: McpServer): ServerCapabilities {
  const manageable = !server.name.includes('/');
  const config = server.source !== 'plugin';
  const remote = server.transport === 'http';
  const known = server.transport === 'http' || server.transport === 'stdio';
  return {
    manageable,
    canSwitch: manageable && config,
    canTest: known,
    autoTest: remote,
    canSignIn: manageable && config && remote && server.auth === 'oauth',
    canRemove: manageable && config && remote,
  };
}

// --- labels ----------------------------------------------------------------

export function authLabel(server: McpServer): 'OAuth' | '令牌' | null {
  if (server.auth === 'oauth') return 'OAuth';
  if (server.auth === 'header') return '令牌';
  return null;
}

/** Second line of a row: the URL's host, or the command for a local server. */
export function serverSubtitle(server: McpServer): string {
  if (server.url) {
    try {
      return new URL(server.url).host;
    } catch {
      return server.url;
    }
  }
  if (server.command) return [server.command, ...(server.args ?? [])].join(' ');
  return '';
}

const tools = (n: unknown): string => {
  const count = typeof n === 'number' && Number.isFinite(n) ? n : 0;
  return `${count} 个工具`;
};

/** True when the switch and the running gateway disagree: the config says on but the server
 * is not loaded, or off but it still is. A reload (or a gateway restart) settles it. */
export function needsReload(server: McpServer, row?: McpRuntimeRow): boolean {
  if (!row) return false;
  const loaded = row.status === 'connected' || row.status === 'lazy';
  if (server.enabled) return row.status === 'disabled' || row.status === 'configured';
  return loaded;
}

/** The runtime status line (spec §5.8); null when there is nothing to show. */
export function statusLine(server: McpServer, row?: McpRuntimeRow): string | null {
  if (!row) return null;
  let line: string;
  switch (row.status) {
    case 'connected':
      line = `已连接 · ${tools(row.tools)}`;
      break;
    case 'lazy':
      line = `就绪 · ${tools(row.tools)}`;
      break;
    case 'connecting':
      return '正在连接…';
    case 'failed':
      return '失败';
    case 'disabled':
      line = '已关闭';
      break;
    case 'configured':
      line = '尚未加载';
      break;
    default:
      return null;
  }
  return needsReload(server, row) ? `${line} · 重新加载后生效` : line;
}

const RUNTIME_STATES = new Set(['connected', 'lazy', 'connecting', 'failed']);

/** Runtime rows by server name (spec §5.8). For an explicitly selected profile the gateway may
 * report no runtime state at all — every row then reads `configured` or `disabled` — and the map
 * is empty so the list shows no misleading "Not loaded yet". */
export function runtimeRowsByName(rows: McpRuntimeRow[], profileSelected: boolean): Map<string, McpRuntimeRow> {
  const list = rows ?? [];
  if (profileSelected && !list.some((r) => RUNTIME_STATES.has(r.status))) return new Map();
  return new Map(list.map((r) => [r.name, r]));
}

/** Small labels on a row: how it authenticates, whether it runs on the gateway, who provides it. */
export function connectorBadges(server: McpServer): string[] {
  const badges: string[] = [];
  const auth = authLabel(server);
  if (auth) badges.push(auth);
  if (server.transport === 'stdio') badges.push('本地');
  if (server.source === 'plugin') badges.push('插件');
  return badges;
}

const plural = (n: number, word: string): string => `${n} 个${word}`;

/** First line of a passed test: "Working · 3 tools · 2 prompts". */
export function testSummary(outcome: { tools: unknown[]; prompts: number; resources: number }): string {
  const parts = [`连接正常 · ${plural(outcome.tools.length, '工具')}`];
  if (outcome.prompts > 0) parts.push(plural(outcome.prompts, '提示词'));
  if (outcome.resources > 0) parts.push(plural(outcome.resources, '资源'));
  return parts.join(' · ');
}

/** Catalog credential fields are masked unless the name says the value is not a secret (spec §5.9). */
export function isPlainEnvField(name: string): boolean {
  return /_(URL|HOST|ID)$/i.test(name);
}

// --- errors (spec §8) ------------------------------------------------------

export type ConnectorAction = 'list' | 'catalog' | 'add' | 'install' | 'switch' | 'remove' | 'signin';

export type ConnectorError =
  | { kind: 'auth' }
  | { kind: 'unsupported'; message: string }
  | { kind: 'gone'; message: string }
  | { kind: 'message'; message: string };

const UNSUPPORTED = '此网关不支持连接器，需要 Hermes 0.21.5 或更新版本。';
const GONE = '此连接器已不存在。';
const UNREACHABLE = '无法连接网关，请检查 VPN 或 Wi-Fi。';

const isRead = (a: ConnectorAction): boolean => a === 'list' || a === 'catalog';
const isServerAction = (a: ConnectorAction): boolean => a === 'switch' || a === 'remove' || a === 'signin';

/** Map a failed connector request to what the screen does and says. */
export function connectorError(error: unknown, action: ConnectorAction): ConnectorError {
  if (error instanceof AuthError) return { kind: 'auth' };
  // The fast request before a slow one failed: nothing was sent, so this is about reaching
  // the gateway, not about the action.
  if (error instanceof McpPreflightError) return connectorError(error.reason, 'list');
  if (error instanceof McpAlreadyAddedError) return { kind: 'message', message: error.message };
  if (error instanceof HttpError) {
    if (error.status === 404) {
      const bare = /^not found$/i.test(error.message) || error.message.startsWith('HTTP 404 on ') ||
        /^请求 .+ 失败（HTTP 404）$/.test(error.message);
      if (isRead(action) && bare) return { kind: 'unsupported', message: UNSUPPORTED };
      if (isServerAction(action)) return { kind: 'gone', message: GONE };
    }
    if (error.status === 0) {
      const write = action === 'add' || action === 'install';
      return {
        kind: 'message',
        message: `网关响应超时。${write ? ' 请先检查列表再重试。' : ''}`,
      };
    }
    // RestClient surfaces only a string `detail`; without one (a FastAPI 422 carries a list)
    // its message is "HTTP <status> on <path>", which is not something to show.
    if (/^HTTP \d+ on /.test(error.message) || /^请求 .+ 失败（HTTP \d+）$/.test(error.message)) {
      return {
        kind: 'message',
        message:
          error.status === 422
            ? '网关无法读取此请求。'
            : `网关返回错误（HTTP ${error.status}).`,
      };
    }
    return { kind: 'message', message: error.message };
  }
  // An old gateway answers unknown /api paths with its HTML shell: res.json() throws SyntaxError.
  if (error instanceof SyntaxError && isRead(action)) return { kind: 'unsupported', message: UNSUPPORTED };
  return { kind: 'message', message: UNREACHABLE };
}

// --- OAuth (spec §5.6) -----------------------------------------------------

/** OAuth needs the gateway on HTTPS: providers do not accept a plain-HTTP redirect. */
export function gatewaySupportsOauth(baseUrl: string): boolean {
  return /^https:\/\//i.test(baseUrl.trim());
}

/** Rule B: null when the authorization URL is safe to open, otherwise the message to show. */
export function checkAuthorizationUrl(url: string, baseUrl: string): string | null {
  let auth: URL;
  try {
    auth = new URL(url);
  } catch {
    return '网关返回了无效的登录地址。';
  }
  if (auth.protocol !== 'https:') return '登录地址未使用 HTTPS，已阻止打开。';

  // Every value is checked: a provider could read a different one than the first.
  const redirects = auth.searchParams.getAll('redirect_uri');
  if (redirects.length === 0) return null; // pushed authorization request: nothing to check

  let want: URL;
  try {
    want = new URL(baseUrl.trim());
  } catch {
    return '应用中配置的网关地址无效。';
  }
  const basePath = want.pathname.replace(/\/+$/, '');
  const prefix = `${basePath}/api/mcp/oauth/callback/`;
  const reachable = redirects.every((redirect) => {
    try {
      const got = new URL(redirect);
      return got.origin === want.origin && got.pathname.startsWith(prefix);
    } catch {
      return false;
    }
  });
  // `origin` drops any credentials in the stored gateway URL.
  return reachable
    ? null
    : `网关的登录回调地址无法由此手机访问，请将网关的 HERMES_DASHBOARD_PUBLIC_URL 设置为 ${want.origin}${basePath}.`;
}

/** The address the gateway asks a provider to send a sign-in back to, unless the gateway is
 * configured with another one. Null when the gateway address is not a URL. */
export function oauthRedirectAddress(baseUrl: string, name: string): string | null {
  let base: URL;
  try {
    base = new URL(baseUrl.trim());
  } catch {
    return null;
  }
  // The gateway uses Python's quote(name, safe=''), which also encodes these five.
  const quoted = encodeURIComponent(name).replace(/[!*'()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  // `origin` drops any credentials in the stored gateway URL.
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}/api/mcp/oauth/callback/${quoted}`;
}

export const OAUTH_NEEDS_HTTPS =
  '登录需要网关使用 HTTPS 地址，提供商不接受普通 HTTP 回调。';

/** A provider's refusal to register the gateway for sign-in, in words. */
export interface OauthRefusal {
  /** It refused the redirect address, which the provider's settings can allow. */
  redirect: boolean;
  /** For the sign-in card. It quotes the provider, so a wrong reading of it shows. */
  message: string;
  /** One line for the test card. */
  summary: string;
  /** What the provider said, cleaned up and cut; null when it gave nothing readable. */
  said: string | null;
}

const REGISTRATION_FAILED = /Registration failed: (\d{3})\b\s*([\s\S]*)$/;
const REDIRECT_CODE = /invalid_redirect_uri/i;
// "redirect_uri", "redirect URIs", "redirection URI", "redirectUri", "redirect-uri"
const REDIRECT_WORD = /redirect(ion)?[_ -]?ur[il]s?/i;
const REFUSED_WORD = /\bnot (allowed|permitted|registered|whitelisted|allowlisted|authori[sz]ed|accepted|valid)\b|\b(disallowed|invalid|unauthori[sz]ed|forbidden)\b/i;
const MAX_PROVIDER_TEXT = 160;

/** Provider text as it may be quoted inside an app sentence: one line, no quotes of its own
 * that would close ours, cut by whole characters. */
function quotable(text: string): string | null {
  const clean = text.replace(/[“”]/g, '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  const chars = Array.from(clean);
  return chars.length > MAX_PROVIDER_TEXT ? `${chars.slice(0, MAX_PROVIDER_TEXT).join('')}…` : clean;
}

const firstText = (...values: unknown[]): string | null => {
  for (const v of values) if (typeof v === 'string' && v.trim()) return v;
  return null;
};

/** What a registration answer says: its OAuth error code, and its words — from the JSON
 * fields providers use, or the body itself when that is short plain text. Markup says nothing. */
function providerAnswer(body: string): { code: string | null; said: string | null } {
  const trimmed = body.trim();
  if (!trimmed || trimmed.startsWith('<')) return { code: null, said: null };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { code: null, said: quotable(trimmed) };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { code: null, said: null };
    const o = parsed as Record<string, unknown>;
    const code = firstText(o.error);
    const said = firstText(o.error_description, o.message, o.detail, o.error);
    return { code, said: said ? quotable(said) : null };
  }
  return { code: null, said: quotable(trimmed) };
}

const ALLOW_REDIRECT =
  '服务器不允许此网关的回调地址，请将其加入允许列表后重新登录。';
const ALLOW_REDIRECT_SUMMARY = '登录尚未配置，服务器不允许此网关的回调地址。';
const itSaid = (said: string | null): string => (said ? ` 返回信息：“${said}”` : '');

/** The gateway passes a provider's registration refusal through as
 * `Registration failed: <status> <body>`. Null for any other text.
 *
 * It counts as a refused redirect address only when the provider's own words (or its error
 * code) say so: a body that merely mentions `redirect_uri` — a validation list, a login page —
 * does not. Outside a registration refusal only the standard error code counts. */
export function explainOauthRefusal(text: string): OauthRefusal | null {
  const failed = REGISTRATION_FAILED.exec(text);
  if (!failed) {
    if (!REDIRECT_CODE.test(text)) return null;
    return { redirect: true, message: ALLOW_REDIRECT, summary: ALLOW_REDIRECT_SUMMARY, said: null };
  }
  const status = failed[1];
  const { code, said } = providerAnswer(failed[2]);
  const refusedRedirect =
    REDIRECT_CODE.test(code ?? '') ||
    REDIRECT_CODE.test(said ?? '') ||
    (said !== null && REDIRECT_WORD.test(said) && REFUSED_WORD.test(said));
  if (refusedRedirect) {
    return { redirect: true, message: `${ALLOW_REDIRECT}${itSaid(said)}`, summary: ALLOW_REDIRECT_SUMMARY, said };
  }
  return {
    redirect: false,
    message: `服务器拒绝注册此网关的登录信息（HTTP ${status}).${itSaid(said)}`,
    summary: `登录尚未配置，服务器拒绝注册此网关（HTTP ${status}).`,
    said,
  };
}

/** What the sign-in card shows for a failed sign-in: the words, and the address to allow when
 * the provider refused it. On a plain-HTTP gateway no address would help: sign-in needs https. */
export function signInProblem(text: string, baseUrl: string | null, name: string): { text: string; address: string | null } {
  const refusal = explainOauthRefusal(text);
  if (!refusal) return { text, address: null };
  if (!refusal.redirect) return { text: refusal.message, address: null };
  if (baseUrl && !gatewaySupportsOauth(baseUrl)) return { text: OAUTH_NEEDS_HTTPS, address: null };
  return { text: refusal.message, address: baseUrl ? oauthRedirectAddress(baseUrl, name) : null };
}

/** The test card's line for a failed test. `withReason`: also quote the provider, when no
 * sign-in card above the test card does. */
export function testFailureLine(text: string, withReason = true): string {
  const refusal = explainOauthRefusal(text);
  if (!refusal) return text;
  return refusal.redirect || !withReason ? refusal.summary : `${refusal.summary}${itSaid(refusal.said)}`;
}

// --- the add forms (spec §5.4, §5.5, §5.9) ----------------------------------

/** One value the add forms collect and hand to ConnectorSecretForm. */
export interface SecretField {
  key: string;
  label: string;
  /** A secure input. Plain only for names that say the value is not a secret. */
  masked: boolean;
  required: boolean;
}

/** One field per variable a catalog entry declares: labelled by the gateway's prompt (or
 * the variable's name), masked unless `isPlainEnvField`. */
export function secretFieldsForEntry(entry: McpCatalogEntry): SecretField[] {
  return (entry.required_env ?? []).map((e) => ({
    key: e.name,
    label: e.prompt?.trim() || e.name,
    masked: !isPlainEnvField(e.name),
    required: Boolean(e.required),
  }));
}

/** The trimmed, non-blank values to send, and the first required field left blank (or null). */
export function collectSecretValues(
  fields: SecretField[],
  values: Record<string, string>,
): { env: Record<string, string>; missing: SecretField | null } {
  const env: Record<string, string> = {};
  let missing: SecretField | null = null;
  for (const field of fields) {
    const value = (values[field.key] ?? '').trim();
    if (value) env[field.key] = value;
    else if (field.required && !missing) missing = field;
  }
  return { env, missing };
}

/** How a catalog entry authenticates, in words. */
export function catalogAuthLabel(entry: McpCatalogEntry): string {
  if (entry.auth_type === 'oauth') return 'OAuth 登录';
  if (!entry.auth_type || entry.auth_type === 'none') return '无需登录';
  return entry.auth_type;
}

/** "Sign in again" only when the last test saw a token on the gateway; otherwise "Sign in". */
export function signInLabel(outcome: McpTestOutcome | null): '登录' | '重新登录' {
  return outcome && outcome.kind !== 'error' && outcome.tokensPresent === true ? '重新登录' : '登录';
}

/** The Remove alert. Removing deletes only the config entry: tokens stay on the gateway. */
export function removeConfirmation(name: string): { title: string; message: string } {
  return {
    title: `移除 ${name}?`,
    message:
      '重新加载或重启网关后，智能体将停止使用此连接器。登录信息和令牌仍保留在网关，需在网关上另行删除。',
  };
}

/** After an add whose answer never arrived: is the server the gateway has the one just submitted? */
export function sameServerAddress(server: McpServer, submittedUrl: string): boolean {
  return server.url !== null && server.url === submittedUrl.trim();
}
