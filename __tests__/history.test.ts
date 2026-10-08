// __tests__/history.test.ts
import type { SessionMessage } from '../src/api/types';
import { historyToItems } from '../src/lib/history';

function keyer() {
  let i = 0;
  return () => `k${i++}`;
}

const msg = (m: Partial<SessionMessage>): SessionMessage =>
  ({ role: 'user', timestamp: 0, ...m }) as SessionMessage;

describe('historyToItems', () => {
  it('maps user and assistant rows to complete text items', () => {
    const items = historyToItems(
      [msg({ role: 'user', content: 'hi' }), msg({ role: 'assistant', content: 'hello!' })],
      keyer(),
    );
    expect(items).toEqual([
      { key: 'k0', role: 'user', text: 'hi', complete: true },
      { key: 'k1', role: 'assistant', text: 'hello!', complete: true },
    ]);
  });

  it('drops empty user/assistant rows (e.g. assistant rows that only carry tool_calls)', () => {
    const items = historyToItems(
      [
        msg({ role: 'assistant', content: '' }),
        msg({ role: 'assistant', content: null }),
        msg({ role: 'user', content: '  \n ' }),
        msg({ role: 'user', content: 'real' }),
      ],
      keyer(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe('real');
  });

  it('maps role=tool rows into completed ToolInfo cards', () => {
    const items = historyToItems(
      [
        msg({
          role: 'tool',
          tool_name: 'write_file',
          tool_call_id: 'call_39533c19b0624626ba271be6',
          content: '{"bytes_written": 5763, "dirs_created": true}',
        }),
      ],
      keyer(),
    );
    expect(items).toHaveLength(1);
    const it0 = items[0];
    expect(it0.role).toBe('tool');
    expect(it0.text).toBe('write_file');
    expect(it0.tool).toEqual({
      id: 'call_39533c19b0624626ba271be6',
      name: 'write_file',
      running: false,
      detail: '{"bytes_written": 5763, "dirs_created": true}',
    });
  });

  it('keeps tool cards whose result is empty (name-only card, no detail)', () => {
    const items = historyToItems(
      [msg({ role: 'tool', tool_name: 'skill_view', tool_call_id: 'c1', content: '' })],
      keyer(),
    );
    expect(items).toHaveLength(1);
    expect(items[0].tool).toEqual({ id: 'c1', name: 'skill_view', running: false });
  });

  it('drops tool rows with neither a name nor content', () => {
    expect(
      historyToItems([msg({ role: 'tool', tool_name: null, content: '' })], keyer()),
    ).toEqual([]);
  });

  it('falls back to the item key when tool_call_id is missing', () => {
    const items = historyToItems(
      [msg({ role: 'tool', tool_name: 'bash', tool_call_id: null, content: 'ok' })],
      keyer(),
    );
    expect(items[0].tool!.id).toBe(items[0].key);
  });

  it('classifies a denied tool result: outcome denied, and its user_summary as the summary', () => {
    const denied = JSON.stringify({
      output: '',
      exit_code: -1,
      error: 'BLOCKED: User denied this command.',
      status: 'blocked',
      user_summary: 'You denied this command — it did not run.',
    });
    const items = historyToItems([msg({ role: 'tool', tool_name: 'terminal', tool_call_id: 'c1', content: denied })], keyer());
    expect(items[0].tool).toMatchObject({ outcome: 'denied', summary: 'You denied this command — it did not run.' });
  });

  it('a normal tool result has no outcome (absent = ok)', () => {
    const items = historyToItems([msg({ role: 'tool', tool_name: 'bash', tool_call_id: 'c1', content: '{"error":null,"exit_code":2}' })], keyer());
    expect(items[0].tool!.outcome).toBeUndefined();
  });

  it('classifies the FULL result, not the 4000-char detail (a failure past the cut still counts)', () => {
    const content = JSON.stringify({ output: 'x'.repeat(5000), error: 'boom' });
    const items = historyToItems([msg({ role: 'tool', tool_name: 'bash', tool_call_id: 'c1', content })], keyer());
    expect(items[0].tool!.detail).toHaveLength(4000);
    expect(items[0].tool!.outcome).toBe('failed');
  });

  it('truncates oversized tool results to 4000 chars', () => {
    const items = historyToItems(
      [msg({ role: 'tool', tool_name: 't', content: 'x'.repeat(5000) })],
      keyer(),
    );
    expect(items[0].tool!.detail).toHaveLength(4000);
  });

  it('skips system rows and preserves interleaved order', () => {
    const items = historyToItems(
      [
        msg({ role: 'system', content: 'you are hermes' }),
        msg({ role: 'user', content: 'do it' }),
        msg({ role: 'assistant', content: null }),
        msg({ role: 'tool', tool_name: 'bash', tool_call_id: 'c1', content: 'done' }),
        msg({ role: 'assistant', content: 'All done.' }),
      ],
      keyer(),
    );
    expect(items.map((i) => i.role)).toEqual(['user', 'tool', 'assistant']);
  });

  it('extracts text from structured parts content via messageText', () => {
    const items = historyToItems(
      [msg({ role: 'assistant', content: [{ type: 'text', text: 'part' }] })],
      keyer(),
    );
    expect(items[0].text).toBe('part');
  });

  it('restores tool-call context by merging assistant tool_calls into the result card', () => {
    const items = historyToItems(
      [
        msg({
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', function: { name: 'write_file', arguments: '{"path":"/a/b.txt"}' } }],
        }),
        msg({ role: 'tool', tool_name: 'write_file', tool_call_id: 'c1', content: '{"bytes_written":3}' }),
      ],
      keyer(),
    );
    // The invocation-only assistant row does not render; only the tool card.
    expect(items).toHaveLength(1);
    expect(items[0].tool).toEqual({
      id: 'c1',
      name: 'write_file',
      running: false,
      context: '/a/b.txt',
      detail: '{"bytes_written":3}',
    });
  });

  it('joins on call_id when id is absent', () => {
    const items = historyToItems(
      [
        msg({ role: 'assistant', content: '', tool_calls: [{ call_id: 'c2', function: { name: 'terminal', arguments: '{"command":"ls"}' } }] }),
        msg({ role: 'tool', tool_name: 'terminal', tool_call_id: 'c2', content: 'a b c' }),
      ],
      keyer(),
    );
    expect(items[0].tool!.context).toBe('ls');
  });

  it('keeps the tool card at the result-row position (not the invocation row)', () => {
    const items = historyToItems(
      [
        msg({ role: 'assistant', content: '', tool_calls: [{ id: 'c3', function: { name: 'read_file', arguments: '{"path":"/x"}' } }] }),
        msg({ role: 'assistant', content: 'thinking out loud' }),
        msg({ role: 'tool', tool_name: 'read_file', tool_call_id: 'c3', content: 'data' }),
      ],
      keyer(),
    );
    expect(items.map((i) => i.role)).toEqual(['assistant', 'tool']);
    expect(items[1].tool!.context).toBe('/x');
  });

  it('does not throw on non-array or malformed tool_calls', () => {
    const items = historyToItems(
      [
        msg({ role: 'assistant', content: '', tool_calls: 'oops' as any }),
        msg({ role: 'assistant', content: '', tool_calls: [{ id: 'c4', function: { name: 'terminal', arguments: 'not json' } }] }),
        msg({ role: 'tool', tool_name: 'terminal', tool_call_id: 'c4', content: 'ok' }),
      ],
      keyer(),
    );
    // Malformed args → card renders with no context, never throws.
    expect(items).toHaveLength(1);
    expect(items[0].tool!.name).toBe('terminal');
    expect(items[0].tool!.context).toBeUndefined();
  });

  it('treats an object (non-array) tool_calls as having no invocations', () => {
    // Spec §5a: `{}` (object, not array) must fall through to text handling and
    // never throw — Array.isArray({}) is false so no invocation is indexed.
    const items = historyToItems(
      [
        msg({ role: 'assistant', content: 'hi', tool_calls: {} as any }),
        msg({ role: 'tool', tool_name: 'terminal', tool_call_id: 'nope', content: 'ok' }),
      ],
      keyer(),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ role: 'assistant', text: 'hi' });
    expect(items[1].tool!.context).toBeUndefined();
  });

  it('handles a combined row: assistant prose + reasoning + tool_calls, plus the tool result (5a+5b)', () => {
    // Spec §5b: the two features must compose on a single assistant row — the
    // prose+reasoning item AND the result-positioned tool card, nothing dropped
    // or duplicated.
    const items = historyToItems(
      [
        msg({
          role: 'assistant',
          content: 'ans',
          reasoning_content: 'why',
          tool_calls: [{ id: 'c1', function: { name: 'write_file', arguments: '{"path":"/a.ts"}' } }],
        }),
        msg({ role: 'tool', tool_name: 'write_file', tool_call_id: 'c1', content: 'done' }),
      ],
      keyer(),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ role: 'assistant', text: 'ans', reasoning: 'why' });
    expect(items[1].role).toBe('tool');
    expect(items[1].tool).toMatchObject({
      name: 'write_file',
      context: '/a.ts',
      detail: 'done',
      running: false,
    });
  });

  it('renders an orphan tool result (no invocation) unchanged', () => {
    const items = historyToItems(
      [msg({ role: 'tool', tool_name: 'write_file', tool_call_id: 'zzz', content: 'r' })],
      keyer(),
    );
    expect(items[0].tool).toEqual({ id: 'zzz', name: 'write_file', running: false, detail: 'r' });
  });

  it('attaches reasoning to the assistant item and keeps the prose', () => {
    const items = historyToItems(
      [msg({ role: 'assistant', content: 'answer', reasoning_content: 'because' })],
      keyer(),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ role: 'assistant', text: 'answer', reasoning: 'because' });
  });

  it('emits a reasoning-only assistant item with empty text', () => {
    const items = historyToItems(
      [msg({ role: 'assistant', content: '', reasoning: 'just thinking' })],
      keyer(),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ role: 'assistant', text: '', reasoning: 'just thinking' });
  });

  it('drops an assistant row with neither prose nor reasoning', () => {
    const items = historyToItems([msg({ role: 'assistant', content: '' })], keyer());
    expect(items).toHaveLength(0);
  });

  // A turn stopped right after a tool result: the gateway closes the stored transcript with its
  // own assistant row (agent/message_sanitization.py close_interrupted_tool_sequence, v2026.9.24).
  // The live stream never carries that text; the live transcript shows the "Stopped" marker.
  describe('the gateway\'s closing row of a stopped turn', () => {
    const stopped = { role: 'status', text: '已停止', marker: 'stopped' };

    it('becomes the Stopped marker, at its own position', () => {
      const items = historyToItems(
        [
          msg({ role: 'user', content: 'run it' }),
          msg({ role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: '{"command":"sleep 60"}' } }] }),
          msg({ role: 'tool', tool_name: 'terminal', tool_call_id: 'c1', content: '[Tool execution cancelled — terminal was skipped due to user interrupt]' }),
          msg({ role: 'assistant', content: 'Operation interrupted.' }),
          msg({ role: 'user', content: 'next' }),
          msg({ role: 'assistant', content: 'ok' }),
        ],
        keyer(),
      );
      expect(items.map((i) => i.role)).toEqual(['user', 'tool', 'status', 'user', 'assistant']);
      expect(items[2]).toEqual({ key: 'k2', ...stopped });
    });

    // Every text the gateway passes to close_interrupted_tool_sequence on an interrupt, with the
    // values it really interpolates (_failure_hint_for, _clean_error_message's 150-char cut).
    it.each([
      ['Operation interrupted.'],
      ['Operation interrupted: waiting for model response (3.2s elapsed).'],
      ['Operation interrupted during retry (rate limited by upstream provider (429), attempt 2/3).'],
      ['Operation interrupted during retry (upstream server error (502, 12s), attempt 1/3).'],
      ['Operation interrupted: handling API error (API连接Error: 连接 error.).'],
      [`Operation interrupted: handling API error (APIStatusError: ${'x'.repeat(150)}...).`],
      ['Operation interrupted: retrying API call after error (retry 1/3).'],
      ['Operation interrupted: retrying empty response from model (retry 1/2).'],
      ['Operation interrupted: waiting for the provider to recover (cycle 1/4).'],
      ['  Operation interrupted.\n'],
    ])('%j is the marker, not a reply', (content) => {
      const items = historyToItems([msg({ role: 'assistant', content })], keyer());
      expect(items).toEqual([{ key: 'k0', ...stopped }]);
    });

    it('is the marker when the row has an empty tool_calls list and a null finish_reason', () => {
      const items = historyToItems(
        [msg({ role: 'assistant', content: 'Operation interrupted.', tool_calls: [], finish_reason: null })],
        keyer(),
      );
      expect(items).toEqual([{ key: 'k0', ...stopped }]);
    });

    it('is recognized in parts-array content too', () => {
      const items = historyToItems(
        [msg({ role: 'assistant', content: [{ type: 'text', text: 'Operation interrupted.' }] })],
        keyer(),
      );
      expect(items).toEqual([{ key: 'k0', ...stopped }]);
    });

    it.each([
      ['a reply that only mentions it', 'The log says: Operation interrupted.'],
      ['a reply that continues after it', 'Operation interrupted. I will try again with a longer timeout.'],
      ['a multi-line reply that starts with it', 'Operation interrupted: the disk was full.\nHere is what I found.'],
      ['a different sentence with the same start', 'Operation interrupted by the watchdog.'],
      ['a one-line reply in the same shape', 'Operation interrupted: the disk was full.'],
      ['a one-line reply that ends in brackets', 'Operation interrupted: I stopped the script (it hung).'],
    ])('%s stays an assistant message', (_label, content) => {
      const items = historyToItems([msg({ role: 'assistant', content })], keyer());
      expect(items).toEqual([{ key: 'k0', role: 'assistant', text: content, complete: true }]);
    });

    it('a row that carries reasoning is the model\'s own and stays a message', () => {
      const items = historyToItems(
        [msg({ role: 'assistant', content: 'Operation interrupted.', reasoning_content: 'why' })],
        keyer(),
      );
      expect(items).toEqual([{ key: 'k0', role: 'assistant', text: 'Operation interrupted.', complete: true, reasoning: 'why' }]);
    });

    // The gateway's row is stored without a finish_reason; a row the model produced carries one
    // (build_assistant_message, agent/chat_completion_helpers.py at v2026.9.24).
    it('a row with a finish_reason is the model\'s own and stays a message', () => {
      const items = historyToItems(
        [msg({ role: 'assistant', content: 'Operation interrupted.', finish_reason: 'stop' })],
        keyer(),
      );
      expect(items).toEqual([{ key: 'k0', role: 'assistant', text: 'Operation interrupted.', complete: true }]);
    });

    it('a row that calls tools is the model\'s own and stays a message', () => {
      const items = historyToItems(
        [msg({ role: 'assistant', content: 'Operation interrupted.', tool_calls: [{ id: 'c1', function: { name: 'terminal', arguments: '{}' } }] })],
        keyer(),
      );
      expect(items).toEqual([{ key: 'k0', role: 'assistant', text: 'Operation interrupted.', complete: true }]);
    });

    it('a user who types it keeps their message', () => {
      const items = historyToItems([msg({ role: 'user', content: 'Operation interrupted.' })], keyer());
      expect(items).toEqual([{ key: 'k0', role: 'user', text: 'Operation interrupted.', complete: true }]);
    });
  });
});
