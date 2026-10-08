// __tests__/secure-entry.test.ts
import {
  countdownA11y, formatCountdown, provenanceFor, provenanceForCard, provenanceText, secondsRemaining, secureEntryCopy, skillNameOf,
} from '../src/lib/secure-entry';
import type { RequestCardState } from '../src/lib/turn-controller';

const card = (method: 'secret' | 'sudo', params: Record<string, unknown>): RequestCardState => ({
  id: 'srq-s', kind: 'secure-entry', method, params: { session_id: 's', ...params }, status: 'pending',
  legacy: false, receivedAt: 0, anchorKey: null,
});

test('timeouts: secret 300 s, sudo 120 s, never negative', () => {
  expect(secondsRemaining('secret', 1_000, 1_000)).toBe(300);
  expect(secondsRemaining('sudo', 1_000, 1_000)).toBe(120);
  expect(secondsRemaining('secret', 0, 60_500)).toBe(240);
  expect(secondsRemaining('sudo', 0, 999_999)).toBe(0);
});
test('countdown text and VoiceOver label', () => {
  expect(formatCountdown(300)).toBe('5:00');
  expect(formatCountdown(61)).toBe('1:01');
  expect(countdownA11y(61)).toBe('剩余 1 分钟 1 秒');
  expect(countdownA11y(120)).toBe('剩余 2 分钟');
});
test('skill name and provenance, "unknown" whenever the lookup cannot answer', () => {
  const skills = [{ name: 'weather', description: '', category: '', enabled: true, provenance: 'bundled' as const }];
  expect(skillNameOf({ session_id: 's', env_var: 'K', prompt: 'p', metadata: { skill_name: 'weather' } })).toBe('weather');
  expect(skillNameOf({ session_id: 's', env_var: 'K', prompt: 'p' })).toBeNull();
  expect(provenanceFor(skills, 'weather')).toBe('bundled');
  expect(provenanceFor(skills, 'other')).toBe('unknown');
  expect(provenanceFor(null, 'weather')).toBe('unknown');
  expect(provenanceFor([{ ...skills[0], provenance: undefined }], 'weather')).toBe('unknown');
  expect(provenanceText('hub')).toBe('Skills Hub');
  expect(provenanceText('unknown')).toBe('未知');
});
test('secret copy: title, ask, warning, destination, no keychain autofill', () => {
  const c = secureEntryCopy(card('secret', { env_var: 'OPENWEATHER_API_KEY', prompt: 'Your API key', metadata: { skill_name: 'weather' } }));
  expect(c).toMatchObject({
    method: 'secret',
    title: '输入 OPENWEATHER_API_KEY',
    ask: 'Your API key',
    command: null,
    textContentType: 'none',
    warning: '仅在你主动要求此操作时继续。智能体可以编写或修改发起请求的技能。',
    destination: '内容将保存到网关的 .env 文件，智能体可以读取。',
    skillName: 'weather',
    fieldLabel: '输入 OPENWEATHER_API_KEY',
  });
});
test('sudo copy: password autofill, command shown, no warning', () => {
  const c = secureEntryCopy(card('sudo', { command: 'apt-get install jq' }));
  expect(c).toMatchObject({ method: 'sudo', title: '管理员密码', ask: null, command: 'apt-get install jq', textContentType: 'password', warning: null, destination: null, fieldLabel: '管理员密码' });
});

// Task 11 review I1: provenance is decided per card, so settling a card or a second card arriving
// never drops a known source back to "checking…".
describe('provenanceForCard', () => {
  const weather = [{ name: 'weather', description: '', category: '', enabled: true, provenance: 'agent' as const }];
  const secret = (id: string, status: RequestCardState['status'] = 'pending'): RequestCardState => ({
    ...card('secret', { env_var: 'K', prompt: 'p', metadata: { skill_name: 'weather' } }), id, status,
  });

  test('a pending card covered by the lookup gets its source', () => {
    expect(provenanceForCard(secret('a'), { ids: ['a'], list: weather })).toBe('agent');
  });
  test('a pending card whose lookup is still in flight is "checking" (null)', () => {
    expect(provenanceForCard(secret('b'), { ids: ['a'], list: weather })).toBeNull();
    expect(provenanceForCard(secret('b'), null)).toBeNull();
  });
  test('a second card arriving does not reset the first (the older lookup still covers it)', () => {
    const before = { ids: ['a'], list: weather }; // B arrived; the refetch for "a,b" is in flight
    expect(provenanceForCard(secret('a'), before)).toBe('agent');
    expect(provenanceForCard(secret('b'), before)).toBeNull();
    const after = { ids: ['a', 'b'], list: weather };
    expect(provenanceForCard(secret('a'), after)).toBe('agent');
    expect(provenanceForCard(secret('b'), after)).toBe('agent');
  });
  test('a settled card keeps its source from the last lookup, covered or not', () => {
    expect(provenanceForCard(secret('a', 'answered'), { ids: ['a'], list: weather })).toBe('agent');
    expect(provenanceForCard(secret('a', 'skipped'), { ids: ['c'], list: weather })).toBe('agent');
  });
  test('a settled card with no lookup ever, or a failed one, is "unknown"', () => {
    expect(provenanceForCard(secret('a', 'cancelled'), null)).toBe('unknown');
    expect(provenanceForCard(secret('a', 'answered'), { ids: ['a'], list: null })).toBe('unknown');
  });
});

// Final review m3: malformed params used to throw in render (p.env_var of null) and replace the chat.
describe('malformed params (m3)', () => {
  const raw = (method: 'secret' | 'sudo', params: unknown): RequestCardState => ({ ...card(method, {}), params });

  test.each([
    ['null params', null],
    ['no env_var', { session_id: 's', prompt: 'Your key' }],
    ['a blank env_var', { session_id: 's', env_var: ' ', prompt: 'p' }],
    ['a non-string env_var', { session_id: 's', env_var: 42, prompt: 'p' }],
  ])('secret with %s → null (can\'t be shown)', (_name, params) => {
    expect(secureEntryCopy(raw('secret', params))).toBeNull();
  });

  test('a secret with a non-string prompt drops the ask; a bad metadata has no skill name', () => {
    const c = secureEntryCopy(raw('secret', { session_id: 's', env_var: 'K', prompt: 3, metadata: 'weather' }));
    expect(c).toMatchObject({ title: '输入 K', ask: null, skillName: null });
  });

  test('sudo needs no params: null or a non-string command shows the card without a command', () => {
    expect(secureEntryCopy(raw('sudo', null))).toMatchObject({ method: 'sudo', title: '管理员密码', command: null });
    expect(secureEntryCopy(raw('sudo', { session_id: 's', command: ['rm'] }))).toMatchObject({ command: null });
  });

  test('skill name and provenance never throw on null params', () => {
    expect(skillNameOf(null)).toBeNull();
    expect(provenanceForCard({ ...raw('secret', null), status: 'answered' }, null)).toBe('unknown');
  });
});
