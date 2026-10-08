// __tests__/export.test.ts
import type { ChatItem } from '../src/components/message-row';
import { exportAsJsonl, exportAsText } from '../src/lib/export';

const items: ChatItem[] = [
  { key: 'i0', role: 'user', text: 'list my sessions', complete: true },
  {
    key: 'i1',
    role: 'tool',
    text: 'sessions_list',
    tool: { id: 't1', name: 'sessions_list', running: false, summary: 'Found 3 sessions', durationS: 1.2 },
  },
  { key: 'i2', role: 'assistant', text: 'You have **3** sessions.', complete: true },
];

describe('exportAsText', () => {
  it('renders You:/Hermes: turns and tool lines with name + summary', () => {
    expect(exportAsText(items)).toBe(
      '你：list my sessions\n\n[工具] sessions_list：Found 3 sessions\n\nHermes: You have **3** sessions.',
    );
  });

  it('falls back to tool context when there is no summary, and to bare name', () => {
    const tools: ChatItem[] = [
      { key: 'a', role: 'tool', text: 'bash', tool: { id: 't1', name: 'bash', running: false, context: 'ls -la' } },
      { key: 'b', role: 'tool', text: 'read_file', tool: { id: 't2', name: 'read_file', running: false } },
    ];
    expect(exportAsText(tools)).toBe('[工具] bash：ls -la\n\n[工具] read_file');
  });

  it('renders status lines', () => {
    const mixed: ChatItem[] = [{ key: 'a', role: 'status', text: 'Compacting context…' }];
    expect(exportAsText(mixed)).toBe('[状态] Compacting context…');
  });

  it('drops empty user/assistant/status rows and returns "" for no items', () => {
    const sparse: ChatItem[] = [
      { key: 'a', role: 'assistant', text: '   ', complete: true },
      { key: 'b', role: 'user', text: 'hi', complete: true },
      { key: 'c', role: 'status', text: '' },
    ];
    expect(exportAsText(sparse)).toBe('你：hi');
    expect(exportAsText([])).toBe('');
  });
});

describe('exportAsJsonl', () => {
  it('emits one JSON object per item, parseable line by line', () => {
    const out = exportAsJsonl(items);
    const lines = out.split('\n');
    expect(lines).toHaveLength(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0]).toEqual({ role: 'user', text: 'list my sessions' });
    expect(parsed[2]).toEqual({ role: 'assistant', text: 'You have **3** sessions.' });
  });

  it('includes tool fields under tool, snake_cases duration, omits absent ones', () => {
    const [, toolLine] = exportAsJsonl(items).split('\n');
    expect(JSON.parse(toolLine)).toEqual({
      role: 'tool',
      text: 'sessions_list',
      tool: { name: 'sessions_list', summary: 'Found 3 sessions', duration_s: 1.2 },
    });
  });

  it('does not leak local render keys or image uris', () => {
    const withImage: ChatItem[] = [
      { key: 'i9', role: 'user', text: 'look at this', complete: true, imageUri: 'file:///tmp/p.jpg', imageWidth: 100, imageHeight: 80 },
    ];
    const parsed = JSON.parse(exportAsJsonl(withImage));
    expect(parsed).toEqual({ role: 'user', text: 'look at this' });
    expect(exportAsJsonl(withImage)).not.toContain('i9');
  });

  it('handles multi-line text safely (stays one line per item)', () => {
    const multi: ChatItem[] = [{ key: 'a', role: 'assistant', text: 'line1\nline2', complete: true }];
    const out = exportAsJsonl(multi);
    expect(out.split('\n')).toHaveLength(1);
    expect(JSON.parse(out).text).toBe('line1\nline2');
  });

  it('returns "" for no items', () => {
    expect(exportAsJsonl([])).toBe('');
  });

  it('includes reasoning in the JSONL record when present', () => {
    const out = exportAsJsonl([
      { key: 'k0', role: 'assistant', text: 'ans', reasoning: 'because', complete: true },
      { key: 'k1', role: 'assistant', text: 'plain', complete: true },
    ] as any);
    const [a, b] = out.split('\n').map((l) => JSON.parse(l));
    expect(a).toMatchObject({ role: 'assistant', text: 'ans', reasoning: 'because' });
    expect(b.reasoning).toBeUndefined();
  });
});
