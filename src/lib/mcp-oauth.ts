// src/lib/mcp-oauth.ts — the connector OAuth sign-in sequence (spec §5.6).
//
// The gateway runs the OAuth client; the app shows the provider's page and
// waits. All I/O is injected, so the whole sequence is unit-tested.
//
// Rule A: whenever this holds a flow id and stops without `approved`, it
// cancels the flow — a flow left behind can be reopened by the gateway and
// block the server for 5 minutes. A cancel that answers `approved` means the
// sign-in had already succeeded.
import type { McpOauthFlow, McpTool } from '@/api/mcp';
import { AuthError, HttpError } from '@/api/restClient';
import { connectorError } from './mcp';

export const OAUTH_POLL_MS = 2_000;
/** How long to keep polling after the person closes the browser themselves. */
export const OAUTH_FINISH_GRACE_MS = 60_000;
/** The gateway waits 5 minutes for the redirect; stop a little after that. */
export const OAUTH_TOTAL_LIMIT_MS = 360_000;
export const OAUTH_MAX_FAILED_POLLS = 15;
export const OAUTH_CONFLICT_RETRY_MS = 2_000;
/** Longest wait for the browser to close before carrying on (see closeBrowser). */
export const OAUTH_DISMISS_WAIT_MS = 1_500;

export type OauthPhase = 'starting' | 'browser' | 'finishing';

export type OauthOutcome =
  | { kind: 'approved'; tools: McpTool[] }
  | { kind: 'cancelled' }
  /** `gone`: the gateway no longer has this connector. */
  | { kind: 'error'; message: string; gone?: true };

export interface OauthDeps {
  start: () => Promise<McpOauthFlow>;
  poll: (flowId: string) => Promise<McpOauthFlow>;
  /** Resolves with the flow's status AFTER the cancel. */
  cancel: (flowId: string) => Promise<{ status: string }>;
  /** Resolves when the browser closes, for any reason. Rejecting, or resolving
   * `{type: 'locked'}` (iOS: another browser session exists), means no page was shown. */
  openBrowser: (url: string) => Promise<unknown>;
  dismissBrowser: () => void | Promise<unknown>;
  /** Rule B: null when the URL is safe to open, otherwise the message to show. */
  checkUrl: (url: string) => string | null;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  onPhase?: (phase: OauthPhase) => void;
  /** True once the person tapped Cancel or left the screen. */
  isCancelled?: () => boolean;
  /** Retry the start once after a 409: the app has just cancelled a flow for this server. */
  retryConflict?: boolean;
}

interface BrowserState {
  opened: boolean;
  closed: boolean;
  /** No page was ever shown. */
  openFailed: boolean;
}

function announce(deps: OauthDeps, phase: OauthPhase): void {
  try {
    deps.onPhase?.(phase);
  } catch {
    // a listener must not break the sequence
  }
}

/** Start the flow; null when he cancelled during the one retry wait. */
async function startFlow(deps: OauthDeps): Promise<McpOauthFlow | null> {
  try {
    return await deps.start();
  } catch (e) {
    if (!deps.retryConflict || !(e instanceof HttpError) || e.status !== 409) throw e;
    await deps.sleep(OAUTH_CONFLICT_RETRY_MS);
    if (deps.isCancelled?.()) return null; // he gave up while we waited: do not start another flow
    return deps.start();
  }
}

/** The start failed and no flow id came back, so nothing can be cancelled from here. */
function startFailure(e: unknown): OauthOutcome {
  // (A failed fast request — McpPreflightError — is mapped by connectorError as a failure
  // to reach the gateway: no flow was started, so neither text below applies to it.)
  if (e instanceof HttpError && e.status === 0) {
    return {
      kind: 'error',
      message: '网关响应超时，接下来最多 5 分钟内重试可能被拒绝。',
    };
  }
  const mapped = connectorError(e, 'signin');
  if (mapped.kind === 'gone') return { kind: 'error', message: mapped.message, gone: true };
  // AuthError is rethrown before this is reached; the arm only satisfies the type.
  return { kind: 'error', message: mapped.kind === 'auth' ? '会话已过期。' : mapped.message };
}

/** Approved without a tools list in hand: read it once; approval stands even if that read fails. */
async function approvedOutcome(deps: OauthDeps, flowId: string): Promise<OauthOutcome> {
  try {
    const snap = await deps.poll(flowId);
    return { kind: 'approved', tools: snap.tools ?? [] };
  } catch (e) {
    if (e instanceof AuthError) throw e;
    return { kind: 'approved', tools: [] };
  }
}

/** Rule A: cancel, then report `fallback` — unless the cancel says the flow had already succeeded. */
async function stop(deps: OauthDeps, flowId: string, fallback: OauthOutcome): Promise<OauthOutcome> {
  try {
    const res = await deps.cancel(flowId);
    if (res.status === 'approved') return approvedOutcome(deps, flowId);
  } catch (e) {
    if (e instanceof AuthError) throw e;
  }
  return fallback;
}

/** Close the browser if this sequence opened it and it is still up. Never throws, and never
 * waits long: iOS resolves the dismiss inside a UIKit completion that may not run (a page that
 * was never presented), and the cancel that follows must not wait on it. */
async function closeBrowser(deps: OauthDeps, browser: BrowserState): Promise<void> {
  if (!browser.opened || browser.closed) return;
  try {
    await Promise.race([
      Promise.resolve()
        .then(() => deps.dismissBrowser())
        .catch(() => undefined),
      deps.sleep(OAUTH_DISMISS_WAIT_MS),
    ]);
  } catch {
    // closing is best-effort
  }
}

const isLocked = (result: unknown): boolean =>
  typeof result === 'object' && result !== null && (result as { type?: unknown }).type === 'locked';

/** Everything after the flow id is known. May throw; the caller applies rule A to anything thrown. */
async function signIn(deps: OauthDeps, flow: McpOauthFlow, browser: BrowserState): Promise<OauthOutcome> {
  const id = flow.flow_id;

  if (flow.status === 'approved') return approvedOutcome(deps, id);
  // Cancel tapped (or the screen left) while the start request was in flight:
  // never present the browser after that.
  if (deps.isCancelled?.()) return stop(deps, id, { kind: 'cancelled' });
  if (flow.status === 'error') return stop(deps, id, { kind: 'error', message: flow.error || '登录失败。' });
  const url = flow.authorization_url;
  if (flow.status !== 'authorization_required' || !url) {
    return stop(deps, id, { kind: 'error', message: '网关未提供登录页面，请重试。' });
  }
  const refusal = deps.checkUrl(url);
  if (refusal) return stop(deps, id, { kind: 'error', message: refusal });

  announce(deps, 'browser');
  let opening: Promise<unknown>;
  try {
    opening = deps.openBrowser(url);
  } catch (e) {
    opening = Promise.reject(e);
  }
  browser.opened = true;
  opening.then(
    (result) => {
      browser.closed = true;
      if (isLocked(result)) browser.openFailed = true;
    },
    () => {
      browser.closed = true;
      browser.openFailed = true;
    },
  );

  const startedAt = deps.now();
  let closedAt: number | null = null;
  let finishing = false;
  let failedPolls = 0;

  for (;;) {
    await deps.sleep(OAUTH_POLL_MS);
    // Not a time limit: without a page there is nothing to wait for.
    if (browser.openFailed) return stop(deps, id, { kind: 'error', message: '无法打开登录页面。' });
    if (browser.closed && !finishing) {
      finishing = true;
      announce(deps, 'finishing'); // shown as soon as he closes the page, even if the next poll fails
    }

    let snap: McpOauthFlow | null = null;
    try {
      snap = await deps.poll(id);
      failedPolls = 0;
    } catch (e) {
      if (e instanceof AuthError) throw e; // the caller closes the browser first
      if (e instanceof HttpError && e.status === 404) {
        await closeBrowser(deps, browser);
        return { kind: 'error', message: '登录已过期，请重试。' }; // the flow is gone: nothing to cancel
      }
      failedPolls += 1;
    }

    if (snap) {
      if (snap.status === 'approved') {
        await closeBrowser(deps, browser);
        return { kind: 'approved', tools: snap.tools ?? [] };
      }
      if (snap.status === 'error') {
        await closeBrowser(deps, browser);
        return stop(deps, id, { kind: 'error', message: snap.error || '登录失败。' });
      }
      if (snap.status === 'authorization_required' && snap.authorization_url && snap.authorization_url !== url) {
        await closeBrowser(deps, browser);
        return stop(deps, id, { kind: 'error', message: '网关重新启动了登录流程，请重试。' });
      }
    }

    if (deps.isCancelled?.()) {
      await closeBrowser(deps, browser);
      return stop(deps, id, { kind: 'cancelled' });
    }
    if (failedPolls >= OAUTH_MAX_FAILED_POLLS) {
      await closeBrowser(deps, browser);
      return stop(deps, id, { kind: 'error', message: '登录时与网关断开连接。' });
    }
    // Time limits apply only directly after a poll that succeeded, so returning
    // from another app can never cancel a flow that finished in the meantime.
    if (!snap) continue;

    if (browser.closed) {
      if (closedAt === null) {
        closedAt = deps.now(); // the grace runs from the first poll that succeeded after the close
      } else if (deps.now() - closedAt >= OAUTH_FINISH_GRACE_MS) {
        return stop(deps, id, { kind: 'cancelled' });
      }
    }
    if (deps.now() - startedAt >= OAUTH_TOTAL_LIMIT_MS) {
      await closeBrowser(deps, browser);
      return stop(deps, id, { kind: 'error', message: '登录超时。' });
    }
  }
}

/** Run one sign-in. Rejects only with AuthError, and only after closing the browser. */
export async function runOauthSignIn(deps: OauthDeps): Promise<OauthOutcome> {
  announce(deps, 'starting');
  let flow: McpOauthFlow | null;
  try {
    flow = await startFlow(deps);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    return startFailure(e);
  }
  if (!flow) return { kind: 'cancelled' };

  const browser: BrowserState = { opened: false, closed: false, openFailed: false };
  try {
    return await signIn(deps, flow, browser);
  } catch (e) {
    await closeBrowser(deps, browser);
    if (e instanceof AuthError) throw e;
    // A dependency threw. Rule A still holds: do not leave the flow behind.
    return stop(deps, flow.flow_id, { kind: 'error', message: '登录意外失败。' });
  }
}

/** What the sign-in card shows while a sign-in runs. */
export function oauthPhaseLine(phase: OauthPhase): string {
  switch (phase) {
    case 'starting':
      return '正在开始登录…';
    case 'browser':
      return '等待你在浏览器中完成登录…';
    case 'finishing':
      return '正在完成登录…';
  }
}
