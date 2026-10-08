// src/api/mcp.ts — MCP connector REST surface (docs/contracts/mcp.md).
//
// Configuration and OAuth go over REST; Test and runtime status are RPCs
// (src/api/mcpSession.ts). The REST server shape is NOT the contract's RPC
// `McpServerSummary`: `env` is a redacted map and there is no
// `oauth_tokens_present`, so the types are declared here.
import { profileQuery } from './profiles';
import { AuthError, HttpError, type RestClient } from './restClient';

type Rest = Pick<RestClient, 'get' | 'post' | 'put' | 'del'>;

const enc = encodeURIComponent;
const serverPath = (name: string, suffix = ''): string => `/api/mcp/servers/${enc(name)}${suffix}`;
const flowPath = (flowId: string): string => `/api/mcp/oauth/flows/${enc(flowId)}`;

/** The gateway waits up to 30 s for the authorization URL before answering. */
export const OAUTH_START_TIMEOUT_MS = 45_000;

/** Installing a catalog entry connects to the server to list its tools (up to ~40 s). */
export const INSTALL_TIMEOUT_MS = 45_000;

/** Values shorter than this are not searched for in error text (they would match by accident). */
export const MIN_SECRET_LENGTH = 4;

export type McpTransport = 'http' | 'stdio' | 'unknown';

/** Row from GET /api/mcp/servers. */
export interface McpServer {
  name: string;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  args: string[];
  /** Redacted by the gateway; never a real secret. */
  env: Record<string, string>;
  /** 'oauth', 'header', or null for none. */
  auth: string | null;
  enabled: boolean;
  /** Tool filter as configured (a list or an object), or null for all. Not a tool count. */
  tools: unknown;
  source: 'config' | 'plugin';
  plugin: string | null;
}

export interface McpTool {
  name: string;
  description: string;
}

export type McpOauthStatus = 'starting' | 'authorization_required' | 'approved' | 'error';

export interface McpOauthFlow {
  flow_id: string;
  server_name: string;
  status: McpOauthStatus;
  authorization_url: string | null;
  error: string | null;
  /** Present on a status read once approved. */
  tools?: McpTool[];
}

export interface McpCatalogEnv {
  name: string;
  prompt: string;
  required: boolean;
}

export interface McpCatalogEntry {
  name: string;
  description: string;
  connector_slug: string | null;
  source: string | null;
  transport: string;
  auth_type: string;
  required_env: McpCatalogEnv[];
  url: string | null;
  needs_install: boolean;
  installed: boolean;
  enabled: boolean;
}

export interface McpCatalog {
  entries: McpCatalogEntry[];
  diagnostics: { name: string; kind: string; message: string }[];
}

export type McpAddBody =
  | { name: string; url: string; auth: 'none' | 'oauth' }
  | { name: string; url: string; auth: 'header'; bearer_token: string };

export interface McpInstallResult {
  ok: boolean;
  name: string;
  background: boolean;
}

// --- secret-safe errors (spec §5.9) ---------------------------------------

function secretVariants(value: string): string[] {
  const trimmed = value.trim();
  const forms = [value, trimmed, trimmed.replace(/^bearer\s+/i, '')];
  return [...new Set(forms)].filter((v) => v.length >= MIN_SECRET_LENGTH);
}

/** True when `text` contains any submitted value: as typed, trimmed, or without a leading `Bearer `. */
export function containsSecret(text: string, values: readonly string[]): boolean {
  return values.some((value) => secretVariants(value).some((v) => text.includes(v)));
}

const CLEAN_MESSAGES: Record<number, string> = {
  400: '网关拒绝添加此连接器。',
  409: '已存在同名连接器。',
};

/** Always a NEW error (AuthError aside): nothing the rejection carried — a `cause`, a
 * non-Error throwable — can leave with it. A value echoed in a transformed form
 * (URL-encoded, JSON-escaped, case-changed) is not recognised. */
function cleanError(e: unknown, values: readonly string[]): Error {
  if (e instanceof AuthError) return e; // fixed client-side text, never the gateway's
  if (e instanceof HttpError) {
    const message = containsSecret(e.message, values)
      ? (CLEAN_MESSAGES[e.status] ?? `网关返回错误（HTTP ${e.status}).`)
      : e.message;
    return new HttpError(e.status, message);
  }
  // Network failure, non-JSON body, or a throwable that is not an Error: never forward the object.
  return new Error('请求失败。');
}

/** Run a request that carries secret values; nothing that echoes one may leave this function. */
async function withSecrets<T>(values: readonly string[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    throw cleanError(e, values);
  }
}

// --- servers ---------------------------------------------------------------

export async function listMcpServers(rest: Rest, profile?: string | null): Promise<McpServer[]> {
  const res = await rest.get<{ servers: McpServer[] }>(`/api/mcp/servers${profileQuery(profile, '?')}`);
  return res.servers;
}

/** Add a remote server. A bearer token goes to the profile's .env on the gateway; the app keeps nothing. */
export function addMcpServer(rest: Rest, body: McpAddBody, profile?: string | null): Promise<McpServer> {
  const secrets = body.auth === 'header' ? [body.bearer_token] : [];
  return withSecrets(secrets, () => rest.post<McpServer>(`/api/mcp/servers${profileQuery(profile, '?')}`, body));
}

export function removeMcpServer(rest: Rest, name: string, profile?: string | null): Promise<{ ok: boolean }> {
  return rest.del<{ ok: boolean }>(`${serverPath(name)}${profileQuery(profile, '?')}`);
}

export function setMcpServerEnabled(
  rest: Rest,
  name: string,
  enabled: boolean,
  profile?: string | null,
): Promise<{ ok: boolean; name: string; enabled: boolean }> {
  return rest.put<{ ok: boolean; name: string; enabled: boolean }>(
    `${serverPath(name, '/enabled')}${profileQuery(profile, '?')}`,
    { enabled },
  );
}

// --- slow requests (spec §6.1) ---------------------------------------------

/** The fast request sent before a slow one failed, so the slow request was NOT sent.
 * `reason` is that request's own error (a failure to read the list, not of the action). */
export class McpPreflightError extends Error {
  constructor(readonly reason: unknown) {
    super('无法连接网关。');
    this.name = 'McpPreflightError';
  }
}

/** A catalog entry whose name is already configured: installing it again would overwrite it. */
export class McpAlreadyAddedError extends Error {
  constructor(readonly serverName: string) {
    super('此连接器已添加。');
    this.name = 'McpAlreadyAddedError';
  }
}

/** The fast request that must precede a slow one: the gateway writes rotated cookies back
 * only when a handler returns, so a refresh-token rotation must ride a request that
 * finishes quickly, never the slow one that follows. It carries no secret, so it runs
 * outside `withSecrets`. Returns the server list it read. */
async function preflight(rest: Rest, profile?: string | null): Promise<McpServer[]> {
  try {
    return await listMcpServers(rest, profile);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    throw new McpPreflightError(e);
  }
}

// --- OAuth -----------------------------------------------------------------

/** Start a dashboard-mediated OAuth flow: the fast request, then the slow POST. */
export async function startMcpOauth(rest: Rest, name: string, profile?: string | null): Promise<McpOauthFlow> {
  await preflight(rest, profile);
  return rest.post<McpOauthFlow>(
    `${serverPath(name, '/auth')}${profileQuery(profile, '?')}`,
    {},
    { timeoutMs: OAUTH_START_TIMEOUT_MS },
  );
}

export function getMcpOauthFlow(rest: Rest, flowId: string): Promise<McpOauthFlow> {
  return rest.get<McpOauthFlow>(flowPath(flowId));
}

/** Cancel a flow. `status` is the flow's status AFTER the cancel — 'approved' means it had already succeeded. */
export function cancelMcpOauthFlow(rest: Rest, flowId: string): Promise<{ ok: boolean; status: string }> {
  return rest.del<{ ok: boolean; status: string }>(flowPath(flowId));
}

// --- catalog ---------------------------------------------------------------

export function listMcpCatalog(rest: Rest, profile?: string | null): Promise<McpCatalog> {
  return rest.get<McpCatalog>(`/api/mcp/catalog${profileQuery(profile, '?')}`);
}

/** Install a catalog entry: the fast request, then the slow POST (the gateway connects to
 * the server while installing). `env` values are treated as secrets: the gateway stores
 * them, the app does not.
 *
 * The gateway does not reject an entry that is already configured — it overwrites it and
 * switches it back on — so the list read first also guards that: `McpAlreadyAddedError`. */
export async function installMcpCatalogEntry(
  rest: Rest,
  name: string,
  env: Record<string, string>,
  profile?: string | null,
): Promise<McpInstallResult> {
  const servers = await preflight(rest, profile);
  if (servers.some((s) => s.name === name)) throw new McpAlreadyAddedError(name);
  return withSecrets(Object.values(env), () =>
    rest.post<McpInstallResult>(
      `/api/mcp/catalog/install${profileQuery(profile, '?')}`,
      { name, env, enable: true },
      { timeoutMs: INSTALL_TIMEOUT_MS },
    ),
  );
}
