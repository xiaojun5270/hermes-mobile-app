import { fireEvent, render, screen } from '@testing-library/react-native';
import { ConnectorSignInCard } from '../src/components/connector-sign-in-card';
import { palettes } from '../src/theme';

const colors = palettes.light;
const noop = () => {};

test('idle: the button carries the label and reports a press', async () => {
  const onSignIn = jest.fn();
  await render(<ConnectorSignInCard label="重新登录" phase={null} cancelling={false} note={null} onSignIn={onSignIn} onCancel={noop} />);
  const button = screen.getByRole('button', { name: '重新登录' });
  expect(button).not.toBeDisabled();
  await fireEvent.press(button);
  expect(onSignIn).toHaveBeenCalledTimes(1);
});

test('disabled when the screen is busy with something else', async () => {
  await render(<ConnectorSignInCard label="登录" phase={null} cancelling={false} note={null} disabled onSignIn={noop} onCancel={noop} />);
  expect(screen.getByRole('button', { name: '登录' })).toBeDisabled();
});

test('running: the phase line and a Cancel button replace the Sign in button', async () => {
  const onCancel = jest.fn();
  await render(<ConnectorSignInCard label="登录" phase="browser" cancelling={false} note={null} onSignIn={noop} onCancel={onCancel} />);
  expect(screen.getByText('等待你在浏览器中完成登录…')).toBeTruthy();
  expect(screen.queryByRole('button', { name: '登录' })).toBeNull();
  await fireEvent.press(screen.getByRole('button', { name: '取消登录' }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});

test('cancelling: says so and disables Cancel', async () => {
  await render(<ConnectorSignInCard label="登录" phase="starting" cancelling note={null} onSignIn={noop} onCancel={noop} />);
  expect(screen.getByText('正在取消…')).toBeTruthy();
  expect(screen.getByRole('button', { name: '取消登录' })).toBeDisabled();
});

test('an error note is in the danger colour and not selectable (it can be gateway text)', async () => {
  await render(
    <ConnectorSignInCard label="登录" phase={null} cancelling={false} note={{ tone: 'error', text: 'Registration refused' }} onSignIn={noop} onCancel={noop} />,
  );
  const note = screen.getByText('Registration refused');
  expect(note).toHaveStyle({ color: colors.danger });
  expect(note.props.selectable).toBe(false);
});

test('a note with an address shows it under a label, selectable so it can be copied (the app built it)', async () => {
  const address = 'https://hermes.kite-opah.ts.net/api/mcp/oauth/callback/Gmail';
  await render(
    <ConnectorSignInCard
      label="登录"
      phase={null}
      cancelling={false}
      note={{ tone: 'error', text: 'The server does not allow it.', address }}
      onSignIn={noop}
      onCancel={noop}
    />,
  );
  expect(screen.getByText('The server does not allow it.').props.selectable).toBe(false);
  expect(screen.getByText('回调地址')).toBeTruthy();
  const value = screen.getByText(address);
  expect(value.props.selectable).toBe(true);
  expect(value).toHaveStyle({ color: colors.text });
  expect(screen.getByLabelText(`回调地址：${address}`)).toBeTruthy();
  // The app derives it; a gateway configured with another address uses that one.
  expect(screen.getByText('这是网关默认回调地址。如果网关配置了其他地址，请允许该地址。')).toBeTruthy();
});

test('a note without an address shows no address label', async () => {
  await render(
    <ConnectorSignInCard label="登录" phase={null} cancelling={false} note={{ tone: 'error', text: 'No.', address: null }} onSignIn={noop} onCancel={noop} />,
  );
  expect(screen.queryByText('回调地址')).toBeNull();
});

test('an info note is in the quiet colour', async () => {
  await render(
    <ConnectorSignInCard label="重新登录" phase={null} cancelling={false} note={{ tone: 'info', text: '已登录。' }} onSignIn={noop} onCancel={noop} />,
  );
  expect(screen.getByText('已登录。')).toHaveStyle({ color: colors.textDim });
});
