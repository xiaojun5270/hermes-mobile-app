// src/lib/history.ts — map raw session-DB message rows to renderable ChatItems.
// Contract: docs/contracts/sessions-extra.md → raw /messages row schema.
import type { SessionMessage } from '@/api/types';
import type { ChatItem, ToolInfo } from '@/components/message-row';
import { messageText, reasoningText } from './message-text';
import { toolContextFromArgs } from './tool-context';
import { deniedSummary, toolOutcome } from './tool-outcome';

/** Same cap the live tool.complete path applies to result text. */
const MAX_TOOL_DETAIL = 4000;

/** The gateway's own closing row for a turn stopped right after a tool result: "Operation
 * interrupted." or one of its six lines saying what it was doing (`close_interrupted_tool_sequence`,
 * agent/message_sanitization.py at v2026.9.24; the list is in docs/contracts/sessions-extra.md).
 * Cancellation metadata, not a reply: the live transcript shows the "Stopped" marker instead.
 * Only these exact texts match, so a reply that merely starts the same way is kept. */
const INTERRUPT_CLOSING_ROW =
  /^Operation interrupted(?:\.|(?:: waiting for model response| during retry|: handling API error|: retrying API call after error|: retrying empty response from model|: waiting for the provider to recover) \(.+\)\.)$/;

function isInterruptClosingRow(m: SessionMessage, text: string, reasoning: string): boolean {
  if (m.role !== 'assistant' || reasoning.trim()) return false;
  if (m.finish_reason) return false; // the model produced this row; the gateway's own has none
  if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return false;
  return INTERRUPT_CLOSING_ROW.test(text.trim());
}

export function historyToItems(messages: SessionMessage[], nextKey: () => string): ChatItem[] {
  // Pass 1: index tool-call invocations from assistant rows by id ?? call_id.
  // The invocation lives on the assistant row; its result is a later tool row.
  const invocations = new Map<string, { name?: string; args: unknown }>();
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const tc of m.tool_calls) {
      const id = tc?.id ?? tc?.call_id;
      if (!id) continue;
      let args: unknown;
      const raw = tc?.function?.arguments;
      if (typeof raw === 'string') {
        try { args = JSON.parse(raw); } catch { args = undefined; }
      }
      invocations.set(id, { name: tc?.function?.name, args });
    }
  }

  // Pass 2: emit items at their natural (result-row) positions.
  const items: ChatItem[] = [];
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'assistant') {
      const text = messageText(m);
      const reasoning = m.role === 'assistant' ? reasoningText(m).slice(0, MAX_TOOL_DETAIL) : '';
      if (!text.trim() && !reasoning.trim()) continue; // drop only if nothing to show
      if (isInterruptClosingRow(m, text, reasoning)) {
        items.push({ key: nextKey(), role: 'status', text: '已停止', marker: 'stopped' });
        continue;
      }
      items.push({
        key: nextKey(),
        role: m.role,
        text,
        complete: true,
        ...(reasoning.trim() ? { reasoning } : {}),
      });
    } else if (m.role === 'tool') {
      const name = m.tool_name?.trim();
      const result = messageText(m);
      const detail = result.trim().slice(0, MAX_TOOL_DETAIL);
      if (!name && !detail) continue; // drop empty rows
      const key = nextKey();
      const inv = m.tool_call_id ? invocations.get(m.tool_call_id) : undefined;
      const context = inv ? toolContextFromArgs(inv.name ?? name ?? 'tool', inv.args) : undefined;
      // Classified from the FULL stored text, like the live row (the detail is cut at 4000 chars).
      const outcome = toolOutcome(result);
      const summary = outcome === 'denied' ? deniedSummary(result) : undefined;
      const tool: ToolInfo = {
        id: m.tool_call_id || key,
        name: name || inv?.name || 'tool',
        running: false,
        ...(context ? { context } : {}),
        ...(detail ? { detail } : {}),
        ...(outcome !== 'ok' ? { outcome } : {}),
        ...(summary ? { summary } : {}),
      };
      items.push({ key, role: 'tool', text: tool.name, tool });
    }
  }
  return items;
}
