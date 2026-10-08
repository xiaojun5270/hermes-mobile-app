// src/lib/tool-context.ts
// Port of hermes-agent's build_tool_preview (agent/display.py:167-300), with
// Chinese labels for locally generated summaries; argument/code text stays unchanged.
// Pure; takes ALREADY-PARSED args (the caller
// JSON.parses the persisted tool_calls[].function.arguments string). Returns
// undefined when there's nothing useful to show (gateway returns None).

// 80 matches the live wire EXACTLY: the app's tool.start payload.context is
// built by the dashboard gateway via /api/ws → tui_gateway.ws.handle_ws →
// tui_gateway/server.py `_tool_ctx` → build_tool_preview(name, args, max_len=80).
// (NOT build_tool_preview's own default of 0/unlimited, which only feeds the
// chat-completions SSE `label` path in gateway/platforms/api_server.py — a
// different frontend the mobile app never consumes.) Keep this at 80 so a
// rehydrated card's argument preview keeps the live event's truncation limit.
const MAX_LEN = 80;

// display.py:203-214 — tool name → its primary argument key.
const PRIMARY_ARG: Record<string, string> = {
  terminal: 'command', web_search: 'query', web_extract: 'urls',
  read_file: 'path', write_file: 'path', patch: 'path',
  search_files: 'pattern', browser_navigate: 'url',
  browser_click: 'ref', browser_type: 'text',
  image_generate: 'prompt', text_to_speech: 'text',
  vision_analyze: 'question', mixture_of_agents: 'user_prompt',
  skill_view: 'name', skills_list: 'category',
  cronjob: 'action',
  execute_code: 'code', delegate_task: 'goal',
  clarify: 'question', skill_manage: 'name',
};

// display.py:283 — fallback key order for unmapped tools.
const FALLBACK_KEYS = ['query', 'text', 'command', 'path', 'name', 'prompt', 'code', 'goal'];

/** display.py:167-169 — collapse all whitespace (incl. newlines) to single spaces. */
function oneline(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(' ');
}

/** display.py:172-177 */
function truncate(text: string, maxLen: number): string {
  if (maxLen > 0 && text.length > maxLen) {
    if (maxLen <= 3) return '.'.repeat(maxLen);
    return text.slice(0, maxLen - 3) + '...';
  }
  return text;
}

function asRecord(args: unknown): Record<string, unknown> | null {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : null;
}

/** display.py:180-190 */
function delegateGoalParts(tasks: unknown, perGoalLen: number): [number, string[]] {
  if (!Array.isArray(tasks)) return [0, []];
  const goals: string[] = [];
  for (const task of tasks) {
    if (!task || typeof task !== 'object' || Array.isArray(task)) continue;
    const rawGoal = (task as Record<string, unknown>).goal;
    const goal = rawGoal == null ? '?' : oneline(String(rawGoal));
    goals.push(truncate(goal || '?', perGoalLen));
  }
  return [goals.length, goals];
}

export function toolContextFromArgs(
  toolName: string,
  args: unknown,
  maxLen: number = MAX_LEN,
): string | undefined {
  const a = asRecord(args);
  if (!a || Object.keys(a).length === 0) return undefined; // display.py:201 `if not args`

  // delegate_task (display.py:217-230)
  if (toolName === 'delegate_task') {
    const tasks = a.tasks;
    if (tasks && Array.isArray(tasks)) {
      const [count, goals] = delegateGoalParts(tasks, 40);
      const preview = goals.length
        ? `${count} 个任务：${goals.join(' | ')}`
        : `${tasks.length} 个并行任务`;
      return truncate(preview, maxLen) || undefined;
    }
    const goal = a.goal;
    if (goal == null) return undefined;
    const preview = oneline(String(goal));
    return preview ? truncate(preview, maxLen) : undefined;
  }

  // process (display.py:232-244)
  if (toolName === 'process') {
    const action = a.action == null ? '' : String(a.action);
    const sid = a.session_id == null ? '' : String(a.session_id);
    const data = a.data == null ? '' : String(a.data);
    const parts: string[] = [action];
    if (sid) parts.push(sid.slice(0, 16));
    if (data) parts.push(`"${oneline(data.slice(0, 20))}"`);
    if (a.timeout && action === 'wait') parts.push(`${a.timeout}s`);
    const joined = parts.join(' ');
    return joined.trim() ? joined : undefined;
  }

  // todo (display.py:246-254)
  if (toolName === 'todo') {
    const todos = a.todos;
    if (todos == null) return '读取任务列表';
    const n = Array.isArray(todos) ? todos.length : 0;
    return a.merge ? `更新 ${n} 个任务` : `规划 ${n} 个任务`;
  }

  // session_search (display.py:256-258)
  if (toolName === 'session_search') {
    const query = oneline(a.query == null ? '' : String(a.query));
    return `回忆: "${query.slice(0, 25)}${query.length > 25 ? '...' : ''}"`;
  }

  // memory (display.py:260-272)
  if (toolName === 'memory') {
    const action = a.action == null ? '' : String(a.action);
    const target = a.target == null ? '' : String(a.target);
    if (action === 'add') {
      const content = oneline(a.content == null ? '' : String(a.content));
      return `+${target}: "${content.slice(0, 25)}${content.length > 25 ? '...' : ''}"`;
    }
    if (action === 'replace') {
      const old = oneline(a.old_text ? String(a.old_text) : '') || '<缺少 old_text>';
      return `~${target}: "${old.slice(0, 20)}"`;
    }
    if (action === 'remove') {
      const old = oneline(a.old_text ? String(a.old_text) : '') || '<缺少 old_text>';
      return `-${target}: "${old.slice(0, 20)}"`;
    }
    return action || undefined;
  }

  // send_message (display.py:274-279)
  if (toolName === 'send_message') {
    const target = a.target == null ? '?' : String(a.target);
    let msg = oneline(a.message == null ? '' : String(a.message));
    if (msg.length > 20) msg = msg.slice(0, 17) + '...';
    return `发送至 ${target}: "${msg}"`;
  }

  // Primary-arg map, then fallback order (display.py:281-300).
  let key: string | undefined = PRIMARY_ARG[toolName];
  if (!key) {
    for (const fk of FALLBACK_KEYS) {
      if (fk in a) { key = fk; break; }
    }
  }
  if (!key || !(key in a)) return undefined;

  let value = a[key];
  if (Array.isArray(value)) value = value.length ? value[0] : '';
  const preview = oneline(String(value));
  if (!preview) return undefined;
  return maxLen > 0 && preview.length > maxLen ? preview.slice(0, maxLen - 3) + '...' : preview;
}
