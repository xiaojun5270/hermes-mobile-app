import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ConnectorSecretForm, type SubmitResult } from '../src/components/connector-secret-form';
import type { BiometricOutcome } from '../src/lib/biometric';
import type { SecretField } from '../src/lib/mcp';

const TOKEN: SecretField = { key: 'token', label: '令牌', masked: true, required: true };
const URL_FIELD: SecretField = { key: 'N8N_URL', label: '服务器地址', masked: false, required: false };
const SECRET = 'tok-9f3a-very-secret';

const ok = async (): Promise<BiometricOutcome> => ({ ok: true });

function setup(over: Partial<React.ComponentProps<typeof ConnectorSecretForm>> = {}) {
  const onSubmit = jest.fn(async (): Promise<SubmitResult> => ({ ok: true }));
  const authenticate = jest.fn(ok);
  const props = { fields: [TOKEN], submitLabel: '添加连接器', onSubmit, authenticate, ...over };
  return { onSubmit: props.onSubmit as jest.Mock, authenticate: props.authenticate as jest.Mock, props };
}

const press = () =>
  act(async () => {
    await fireEvent.press(screen.getByRole('button', { name: '添加连接器' }));
  });

test('Face ID runs before the value is handed over, and the value goes only to onSubmit', async () => {
  const order: string[] = [];
  const { props, onSubmit } = setup({
    authenticate: jest.fn(async () => {
      order.push('auth');
      return { ok: true } as BiometricOutcome;
    }),
    onSubmit: jest.fn(async () => {
      order.push('submit');
      return { ok: true } as SubmitResult;
    }),
  });
  await render(<ConnectorSecretForm {...props} />);
  await fireEvent.changeText(screen.getByLabelText('令牌'), SECRET);
  await press();
  expect(order).toEqual(['auth', 'submit']);
  expect(onSubmit).toHaveBeenCalledWith({ token: SECRET });
});

test.each([
  ['cancelled', '已取消，未发送任何内容。'],
  ['failed', 'Face ID 验证失败，未发送任何内容。'],
  ['unavailable', '请先设置 Face ID 或设备密码。'],
] as const)('Face ID %s: nothing is sent and the form keeps the value', async (reason, note) => {
  const { props, onSubmit } = setup({ authenticate: jest.fn(async () => ({ ok: false, reason }) as BiometricOutcome) });
  await render(<ConnectorSecretForm {...props} />);
  await fireEvent.changeText(screen.getByLabelText('令牌'), SECRET);
  await press();
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByText(note)).toBeTruthy();
  expect(screen.getByLabelText('令牌').props.value).toBe(SECRET);
  expect(screen.getByRole('button', { name: '添加连接器' })).not.toBeDisabled();
});

test('with no secret fields it is a plain submit button: no Face ID', async () => {
  const { props, onSubmit, authenticate } = setup({ fields: [] });
  await render(<ConnectorSecretForm {...props} />);
  expect(screen.getByText('添加连接器')).toBeTruthy();
  expect(screen.queryByText(/stored there/)).toBeNull();
  await press();
  expect(authenticate).not.toHaveBeenCalled();
  expect(onSubmit).toHaveBeenCalledWith({});
});

test('a required field left blank stops before Face ID', async () => {
  const { props, onSubmit, authenticate } = setup();
  await render(<ConnectorSecretForm {...props} />);
  await press();
  expect(screen.getByText('令牌不能为空。')).toBeTruthy();
  expect(authenticate).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
});

test('a blank optional field is left out; values are trimmed', async () => {
  const { props, onSubmit } = setup({ fields: [TOKEN, URL_FIELD] });
  await render(<ConnectorSecretForm {...props} />);
  await fireEvent.changeText(screen.getByLabelText('令牌'), `  ${SECRET} `);
  await fireEvent.changeText(screen.getByLabelText('服务器地址'), '   ');
  await press();
  expect(onSubmit).toHaveBeenCalledWith({ token: SECRET });
});

test('only optional fields, all blank: submits without Face ID', async () => {
  const { props, onSubmit, authenticate } = setup({ fields: [URL_FIELD] });
  await render(<ConnectorSecretForm {...props} />);
  await press();
  expect(authenticate).not.toHaveBeenCalled();
  expect(onSubmit).toHaveBeenCalledWith({});
});

test('the screen’s own check can stop the submit before anything else', async () => {
  const { props, onSubmit, authenticate } = setup({ beforeSubmit: () => false });
  await render(<ConnectorSecretForm {...props} />);
  await fireEvent.changeText(screen.getByLabelText('令牌'), SECRET);
  await press();
  expect(authenticate).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
});

test('clears the value on success and stays busy: the screen is about to leave', async () => {
  const { props } = setup();
  await render(<ConnectorSecretForm {...props} />);
  await fireEvent.changeText(screen.getByLabelText('令牌'), SECRET);
  await press();
  expect(screen.getByLabelText('令牌').props.value).toBe('');
  expect(screen.getByRole('button', { name: '添加连接器' })).toBeDisabled();
});

test('keeps the value and shows the message on failure', async () => {
  const { props } = setup({ onSubmit: jest.fn(async () => ({ ok: false, message: '已存在同名连接器。' }) as SubmitResult) });
  await render(<ConnectorSecretForm {...props} />);
  await fireEvent.changeText(screen.getByLabelText('令牌'), SECRET);
  await press();
  expect(screen.getByText('已存在同名连接器。')).toBeTruthy();
  expect(screen.getByLabelText('令牌').props.value).toBe(SECRET);
});

test('a throwing onSubmit shows a fixed message, never what was thrown', async () => {
  const { props } = setup({
    onSubmit: jest.fn(async () => {
      throw new Error(`boom ${SECRET}`);
    }),
  });
  await render(<ConnectorSecretForm {...props} />);
  await fireEvent.changeText(screen.getByLabelText('令牌'), SECRET);
  await press();
  expect(screen.getByText('出现问题，请先检查列表再重试。')).toBeTruthy();
  expect(screen.queryByText(new RegExp(SECRET))).toBeNull();
});

test('the value never reaches a log', async () => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
  const { props } = setup({ onSubmit: jest.fn(async () => ({ ok: false, message: 'nope' }) as SubmitResult) });
  await render(<ConnectorSecretForm {...props} />);
  await fireEvent.changeText(screen.getByLabelText('令牌'), SECRET);
  await press();
  for (const spy of spies) {
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain(SECRET);
    spy.mockRestore();
  }
});

test('a masked field is a secure input that iOS will not offer to save; a plain field is visible', async () => {
  const { props } = setup({ fields: [TOKEN, URL_FIELD] });
  await render(<ConnectorSecretForm {...props} />);
  const token = screen.getByLabelText('令牌');
  expect(token.props.secureTextEntry).toBe(true);
  expect(token.props.textContentType).toBe('none');
  expect(token.props.autoComplete).toBe('off');
  expect(token.props.autoCorrect).toBe(false);
  expect(token.props.spellCheck).toBe(false);
  expect(token.props.autoCapitalize).toBe('none');
  const url = screen.getByLabelText('服务器地址');
  expect(url.props.secureTextEntry).toBe(false);
  expect(url.props.textContentType).toBe('none');
  expect(screen.getByText('服务器地址（可选）')).toBeTruthy();
  expect(screen.getByText('内容发送并保存到你的网关，应用不会保留。')).toBeTruthy();
});

test('while the request is out the button is disabled and a second press does nothing', async () => {
  let finish!: (r: SubmitResult) => void;
  const { props, onSubmit } = setup({ onSubmit: jest.fn(() => new Promise<SubmitResult>((resolve) => (finish = resolve))) });
  await render(<ConnectorSecretForm {...props} />);
  await fireEvent.changeText(screen.getByLabelText('令牌'), SECRET);
  // Two presses in the same tick: the second must not start a second request.
  await act(async () => {
    void fireEvent.press(screen.getByRole('button', { name: '添加连接器' }));
    void fireEvent.press(screen.getByRole('button', { name: '添加连接器' }));
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole('button', { name: '添加连接器' })).toBeDisabled();
  expect(screen.getByText('正在添加…')).toBeTruthy();
  await act(async () => finish({ ok: false, message: 'nope' }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: '添加连接器' })).not.toBeDisabled();
});

test('unmounting during the Face ID prompt sends nothing', async () => {
  let answer!: (o: BiometricOutcome) => void;
  const { props, onSubmit } = setup({ authenticate: jest.fn(() => new Promise<BiometricOutcome>((resolve) => (answer = resolve))) });
  const view = await render(<ConnectorSecretForm {...props} />);
  await fireEvent.changeText(screen.getByLabelText('令牌'), SECRET);
  await act(async () => {
    void fireEvent.press(screen.getByRole('button', { name: '添加连接器' }));
  });
  await view.unmount();
  await act(async () => answer({ ok: true }));
  expect(onSubmit).not.toHaveBeenCalled();
});

test('VoiceOver hears that Face ID comes first, and that the form is busy', async () => {
  let finish!: (r: SubmitResult) => void;
  const { props } = setup({ onSubmit: jest.fn(() => new Promise<SubmitResult>((resolve) => (finish = resolve))) });
  await render(<ConnectorSecretForm {...props} />);
  const button = () => screen.getByRole('button', { name: '添加连接器' });
  expect(button().props.accessibilityHint).toBe('先验证 Face ID');
  await fireEvent.changeText(screen.getByLabelText('令牌'), SECRET);
  await act(async () => {
    void fireEvent.press(button());
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(button().props.accessibilityState.busy).toBe(true);
  await act(async () => finish({ ok: false, message: 'nope' }));
  expect(button().props.accessibilityState.busy).toBe(false);
});

test('without fields there is no Face ID hint', async () => {
  const { props } = setup({ fields: [] });
  await render(<ConnectorSecretForm {...props} />);
  expect(screen.getByRole('button', { name: '添加连接器' }).props.accessibilityHint).toBeUndefined();
});
