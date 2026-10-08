import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { TextInput } from 'react-native';
import { SecureEntryCard } from '../src/components/secure-entry-card';
import type { BiometricOutcome } from '../src/lib/biometric';
import type { RequestCardState } from '../src/lib/turn-controller';

jest.mock('../src/components/icon', () => ({ Icon: () => null }));
jest.mock('expo-local-authentication', () => ({ authenticateAsync: jest.fn() }));
const mockFontScale = { value: 1 };
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 402, height: 874, scale: 3, fontScale: mockFontScale.value }),
}));

const SECRET = 'sk-live-DO-NOT-LEAK-4242';
const T0 = 1_700_000_000_000;
const secret = (over: Partial<RequestCardState> = {}): RequestCardState => ({
  id: 'srq-s', kind: 'secure-entry', method: 'secret', status: 'pending', legacy: false, receivedAt: T0, anchorKey: null,
  params: { session_id: 's', env_var: 'OPENWEATHER_API_KEY', prompt: 'Your OpenWeather API key', metadata: { skill_name: 'weather' } },
  ...over,
});
const sudo = (): RequestCardState => ({ ...secret(), method: 'sudo', params: { session_id: 's', command: 'apt-get install jq' } });
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

let spies: jest.SpyInstance[] = [];
beforeEach(() => {
  spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  for (const s of spies) {
    expect(JSON.stringify(s.mock.calls)).not.toContain(SECRET); // never logged, on any path
    s.mockRestore();
  }
  jest.useRealTimers();
});

const ok = async (): Promise<BiometricOutcome> => ({ ok: true });
const field = () => screen.getByLabelText('输入 OPENWEATHER_API_KEY');

test('secret card: ask, skill + provenance as information, warning, destination, textContentType none', async () => {
  await render(<SecureEntryCard card={secret()} provenance="agent" onSend={jest.fn()} onSkip={jest.fn()} authenticate={ok} now={() => T0} />);
  expect(screen.getByText('输入 OPENWEATHER_API_KEY')).toBeOnTheScreen();
  expect(screen.getByText('由智能体请求')).toBeOnTheScreen();
  expect(screen.getByText('Your OpenWeather API key')).toBeOnTheScreen();
  expect(screen.getByText('技能：weather · 来源：由智能体编写')).toBeOnTheScreen();
  expect(screen.getByText('仅在你主动要求此操作时继续。智能体可以编写或修改发起请求的技能。')).toBeOnTheScreen();
  expect(screen.getByText('内容将保存到网关的 .env 文件，智能体可以读取。')).toBeOnTheScreen();
  expect(field().props).toMatchObject({ secureTextEntry: true, autoCorrect: false, autoCapitalize: 'none', spellCheck: false, textContentType: 'none' });
});

test('provenance: failed lookup shows unknown; loading shows 正在检查…', async () => {
  const { rerender } = await render(<SecureEntryCard card={secret()} provenance={null} onSend={jest.fn()} onSkip={jest.fn()} now={() => T0} />);
  expect(screen.getByText('技能：weather · 来源：正在检查…')).toBeOnTheScreen();
  await rerender(<SecureEntryCard card={secret()} provenance="unknown" onSend={jest.fn()} onSkip={jest.fn()} now={() => T0} />);
  expect(screen.getByText('技能：weather · 来源：未知')).toBeOnTheScreen();
});

test('sudo card: title, command, password autofill, no warning', async () => {
  await render(<SecureEntryCard card={sudo()} provenance={null} onSend={jest.fn()} onSkip={jest.fn()} now={() => T0} />);
  expect(screen.getByText('apt-get install jq')).toBeOnTheScreen();
  expect(screen.getByLabelText('管理员密码').props.textContentType).toBe('password');
  expect(screen.queryByText(/仅在你主动要求/)).toBeNull();
  expect(screen.getByText('2:00')).toBeOnTheScreen();
});

test('Face ID success: sends the value once, then the field is gone and the card never shows it', async () => {
  const onSend = jest.fn();
  const { rerender, toJSON } = await render(
    <SecureEntryCard card={secret()} provenance="hub" onSend={onSend} onSkip={jest.fn()} authenticate={ok} now={() => T0} />,
  );
  await fireEvent.changeText(field(), SECRET);
  expect(JSON.stringify(toJSON())).toContain(SECRET); // guards the assertion below against a vacuous pass
  await fireEvent.press(screen.getByRole('button', { name: '验证 Face ID 后发送' }));
  expect(onSend).toHaveBeenCalledTimes(1);
  expect(onSend).toHaveBeenCalledWith(SECRET);
  await rerender(<SecureEntryCard card={secret({ status: 'answered' })} provenance="hub" onSend={onSend} onSkip={jest.fn()} authenticate={ok} now={() => T0} />);
  expect(screen.getByText('已发送')).toBeOnTheScreen();
  expect(screen.queryByLabelText('输入 OPENWEATHER_API_KEY')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
  expect(JSON.stringify(toJSON())).not.toContain(SECRET); // Preflight F16: not the value, anywhere in the tree
});

test('Face ID failure sends nothing and keeps the card open', async () => {
  const onSend = jest.fn();
  await render(<SecureEntryCard card={secret()} provenance="hub" onSend={onSend} onSkip={jest.fn()} authenticate={async () => ({ ok: false, reason: 'failed' })} now={() => T0} />);
  await fireEvent.changeText(field(), SECRET);
  await fireEvent.press(screen.getByRole('button', { name: '验证 Face ID 后发送' }));
  expect(onSend).not.toHaveBeenCalled();
  expect(screen.getByText('Face ID 验证失败，未发送任何内容。')).toBeOnTheScreen();
  expect(field()).toBeOnTheScreen();
});

test('app backgrounded during the prompt (app_cancel): nothing sent, value kept to retry (Review Focus 1)', async () => {
  const onSend = jest.fn();
  await render(<SecureEntryCard card={secret()} provenance="hub" onSend={onSend} onSkip={jest.fn()} authenticate={async () => ({ ok: false, reason: 'cancelled' })} now={() => T0} />);
  await fireEvent.changeText(field(), SECRET);
  await fireEvent.press(screen.getByRole('button', { name: '验证 Face ID 后发送' }));
  expect(onSend).not.toHaveBeenCalled();
  expect(screen.getByText('已取消，未发送任何内容。')).toBeOnTheScreen();
  expect(field().props.value).toBe(SECRET);
});

test.each([
  ['resolved', '已在其他设备回答'],
  ['interrupted', '已停止'],
] as const)('card closed (request.cancel %s) while the Face ID prompt is up: nothing sent (Review Focus 1)', async (reason, label) => {
  const onSend = jest.fn();
  const d = deferred<BiometricOutcome>();
  const el = (c: RequestCardState) => <SecureEntryCard card={c} provenance="hub" onSend={onSend} onSkip={jest.fn()} authenticate={() => d.promise} now={() => T0} />;
  const { rerender } = await render(el(secret()));
  await fireEvent.changeText(field(), SECRET);
  await fireEvent.press(screen.getByRole('button', { name: '验证 Face ID 后发送' }));
  await rerender(el(secret({ status: 'cancelled', cancelReason: reason })));
  await act(async () => d.resolve({ ok: true }));
  expect(onSend).not.toHaveBeenCalled();
  expect(screen.getByText(label)).toBeOnTheScreen();
});

test('local timeout passes while the Face ID prompt is up: nothing sent (Review Focus 1)', async () => {
  // No countdown tick lands between the deadline and the prompt resolving: the form itself must
  // re-check the deadline after Face ID instead of trusting that a tick already closed the card.
  let clock = T0;
  const onSend = jest.fn();
  const d = deferred<BiometricOutcome>();
  await render(<SecureEntryCard card={secret()} provenance="hub" onSend={onSend} onSkip={jest.fn()} authenticate={() => d.promise} now={() => clock} />);
  await fireEvent.changeText(field(), SECRET);
  await fireEvent.press(screen.getByRole('button', { name: '验证 Face ID 后发送' }));
  clock = T0 + 300_000;
  await act(async () => d.resolve({ ok: true }));
  expect(onSend).not.toHaveBeenCalled();
  expect(screen.getByText('已超时')).toBeOnTheScreen();
  expect(screen.queryByDisplayValue(SECRET)).toBeNull();
});

test('unmounted while the Face ID prompt is up: nothing sent (Review Focus 1)', async () => {
  const onSend = jest.fn();
  const d = deferred<BiometricOutcome>();
  const { unmount } = await render(<SecureEntryCard card={secret()} provenance="hub" onSend={onSend} onSkip={jest.fn()} authenticate={() => d.promise} now={() => T0} />);
  await fireEvent.changeText(field(), SECRET);
  await fireEvent.press(screen.getByRole('button', { name: '验证 Face ID 后发送' }));
  await unmount();
  await act(async () => d.resolve({ ok: true }));
  expect(onSend).not.toHaveBeenCalled();
});

test('Skip responds without a value and clears the field', async () => {
  const onSkip = jest.fn();
  const onSend = jest.fn();
  await render(<SecureEntryCard card={secret()} provenance="hub" onSend={onSend} onSkip={onSkip} authenticate={ok} now={() => T0} />);
  await fireEvent.changeText(field(), SECRET);
  await fireEvent.press(screen.getByRole('button', { name: '跳过，不发送内容' }));
  expect(onSkip).toHaveBeenCalledTimes(1);
  expect(onSend).not.toHaveBeenCalled();
  expect(screen.queryByDisplayValue(SECRET)).toBeNull();
});

test.each([
  ['interrupted', '已停止'],
  ['resolved', '已在其他设备回答'],
  ['session_closed', '已关闭'],
] as const)('cancel (%s) clears the value: a re-delivered card starts empty', async (reason, label) => {
  const el = (c: RequestCardState) => <SecureEntryCard card={c} provenance="hub" onSend={jest.fn()} onSkip={jest.fn()} authenticate={ok} now={() => T0} />;
  const { rerender } = await render(el(secret()));
  await fireEvent.changeText(field(), SECRET);
  await rerender(el(secret({ status: 'cancelled', cancelReason: reason })));
  expect(screen.getByText(label)).toBeOnTheScreen();
  await rerender(el(secret()));
  expect(field().props.value).toBe('');
});

test('countdown ticks and the card times out locally (value cleared)', async () => {
  jest.useFakeTimers({ now: T0 });
  await render(<SecureEntryCard card={secret()} provenance="hub" onSend={jest.fn()} onSkip={jest.fn()} authenticate={ok} />);
  expect(screen.getByText('5:00')).toBeOnTheScreen();
  await fireEvent.changeText(field(), SECRET);
  await act(async () => jest.advanceTimersByTime(60_000));
  expect(screen.getByText('4:00')).toBeOnTheScreen();
  await act(async () => jest.advanceTimersByTime(240_000));
  expect(screen.getByText('已超时')).toBeOnTheScreen();
  expect(screen.queryByDisplayValue(SECRET)).toBeNull();
});

test('focusing the field hands the screen that field to scroll into view (Review Focus 5, sim S2 B2)', async () => {
  const onInputFocus = jest.fn();
  await render(<SecureEntryCard card={secret()} provenance="hub" onSend={jest.fn()} onSkip={jest.fn()} onInputFocus={onInputFocus} now={() => T0} />);
  await fireEvent(field(), 'focus');
  expect(onInputFocus).toHaveBeenCalledTimes(1);
  // Only a measure callback leaves the form — never the field instance, whose props hold the value.
  const spy = jest.spyOn(TextInput.prototype, 'measureInWindow');
  const cb = jest.fn();
  onInputFocus.mock.calls[0][0](cb);
  expect(spy).toHaveBeenCalledWith(cb);
  expect((spy.mock.contexts[0] as TextInput).props.accessibilityLabel).toBe('输入 OPENWEATHER_API_KEY');
  spy.mockRestore();
});

// Sim S1 §2 V2: numberOfLines 2 cut the env var name ("Value for OPENWEATHER_A…") at accessibility
// sizes; the name is the key fact on a secret card, so the title is never clamped.
test('V2: the secret title is never truncated', async () => {
  await render(<SecureEntryCard card={secret()} provenance="hub" onSend={jest.fn()} onSkip={jest.fn()} now={() => T0} />);
  expect(screen.getByText('输入 OPENWEATHER_API_KEY').props.numberOfLines).toBeUndefined();
});

// Final review m3: malformed params threw in render (p.env_var of null) and replaced the whole chat.
describe('malformed params (m3)', () => {
  test('a secret without a usable env_var: "can\'t be shown", no field, Skip sends the skip response', async () => {
    const onSkip = jest.fn();
    const onSend = jest.fn();
    await render(<SecureEntryCard card={secret({ params: null })} provenance={null} onSend={onSend} onSkip={onSkip} now={() => T0} />);
    expect(screen.getByText('此请求无法显示。')).toBeOnTheScreen();
    expect(screen.queryByPlaceholderText('粘贴或输入内容')).toBeNull();
    expect(screen.queryByLabelText(/^Value for/)).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: '跳过此请求' }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onSend).not.toHaveBeenCalled();
  });

  test('once settled it shows the outcome, no Skip', async () => {
    await render(<SecureEntryCard card={secret({ params: {}, status: 'skipped' })} provenance={null} onSend={jest.fn()} onSkip={jest.fn()} now={() => T0} />);
    expect(screen.getByText('已跳过')).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: '跳过此请求' })).toBeNull();
  });

  test('sudo with null params still asks for the password, without a command', async () => {
    await render(<SecureEntryCard card={{ ...sudo(), params: null }} provenance={null} onSend={jest.fn()} onSkip={jest.fn()} now={() => T0} />);
    expect(screen.getByLabelText('管理员密码')).toBeOnTheScreen();
  });
});

// Sim S3 s3: a fixed 44 pt field was filled edge to edge at accessibility text sizes.
test('the field grows with text size: minHeight, no fixed height, padding scaled by fontScale', async () => {
  mockFontScale.value = 1.5;
  await render(<SecureEntryCard card={secret()} provenance="agent" onSend={jest.fn()} onSkip={jest.fn()} now={() => T0} />);
  const style = field().props.style;
  expect(style.height).toBeUndefined();
  expect(style.minHeight).toBe(44);
  expect(style.paddingVertical).toBe(15);
  mockFontScale.value = 1;
});
