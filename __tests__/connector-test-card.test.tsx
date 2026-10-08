import { fireEvent, render, screen } from '@testing-library/react-native';
import { ConnectorTestCard } from '../src/components/connector-test-card';
import { palettes } from '../src/theme';

const colors = palettes.light;
const noop = () => {};

test('idle and connected: an enabled Test button, no result', async () => {
  const onTest = jest.fn();
  await render(<ConnectorTestCard state={{ phase: 'idle' }} connected onTest={onTest} />);
  const button = screen.getByRole('button', { name: '测试连接' });
  expect(button).not.toBeDisabled();
  fireEvent.press(button);
  expect(onTest).toHaveBeenCalledTimes(1);
});

test('not connected: the button is disabled and the reason is shown (review focus 1)', async () => {
  await render(<ConnectorTestCard state={{ phase: 'idle' }} connected={false} onTest={noop} />);
  expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();
  expect(screen.getByText('请先返回会话并等待连接成功，再回来测试。')).toBeTruthy();
});

test('running: the button is disabled and says Testing', async () => {
  await render(<ConnectorTestCard state={{ phase: 'running' }} connected onTest={noop} />);
  expect(screen.getByRole('button', { name: '测试连接' })).toBeDisabled();
  expect(screen.getByText('正在测试…')).toBeTruthy();
});

test('a passed test shows the summary and each tool', async () => {
  await render(
    <ConnectorTestCard
      connected
      onTest={noop}
      state={{
        phase: 'done',
        outcome: {
          kind: 'ok',
          tools: [
            { name: 'search_issues', description: 'Search issues' },
            { name: 'create_issue', description: '' },
          ],
          prompts: 1,
          resources: 0,
          tokensPresent: true,
        },
      }}
    />,
  );
  expect(screen.getByText('连接正常 · 2 个工具 · 1 个提示词')).toHaveStyle({ color: colors.success });
  expect(screen.getByText('search_issues')).toBeTruthy();
  expect(screen.getByText('Search issues')).toBeTruthy();
  expect(screen.getByText('create_issue')).toBeTruthy();
});

test('a failed test shows the gateway text, in danger, and not selectable', async () => {
  await render(
    <ConnectorTestCard
      connected
      onTest={noop}
      state={{ phase: 'done', outcome: { kind: 'failed', message: 'OAuth authentication required — no token found.', oauthNeeded: true, tokensPresent: false } }}
    />,
  );
  const text = screen.getByText('OAuth authentication required — no token found.');
  expect(text).toHaveStyle({ color: colors.danger });
  expect(text.props.selectable).toBe(false);
});

test('a provider that refused the gateway’s redirect address: one readable line, not its JSON', async () => {
  const raw =
    'Registration failed: 400 {"error":"invalid_client_metadata","error_description":"redirect_uri is not allowed by the account configuration"}';
  await render(
    <ConnectorTestCard connected onTest={noop} state={{ phase: 'done', outcome: { kind: 'failed', message: raw, oauthNeeded: true, tokensPresent: false } }} />,
  );
  const text = screen.getByText('登录尚未配置，服务器不允许此网关的回调地址。');
  expect(text).toHaveStyle({ color: colors.danger });
  expect(screen.queryByText(/invalid_client_metadata/)).toBeNull();
});

test('another registration refusal keeps the provider’s reason, unless the sign-in card above already has it', async () => {
  const state = {
    phase: 'done' as const,
    outcome: {
      kind: 'failed' as const,
      message: 'Registration failed: 403 {"message":"Dynamic registration is disabled"}',
      oauthNeeded: true,
      tokensPresent: false,
    },
  };
  const { rerender } = await render(<ConnectorTestCard connected onTest={noop} state={state} />);
  expect(
    screen.getByText('登录尚未配置，服务器拒绝注册此网关（HTTP 403). 返回信息：“Dynamic registration is disabled”'),
  ).toBeTruthy();
  await rerender(<ConnectorTestCard connected onTest={noop} state={state} explainedAbove />);
  expect(screen.getByText('登录尚未配置，服务器拒绝注册此网关（HTTP 403).')).toBeTruthy();
});

test('a call error is shown the same way', async () => {
  await render(
    <ConnectorTestCard connected onTest={noop} state={{ phase: 'done', outcome: { kind: 'error', message: 'socket closed' } }} />,
  );
  expect(screen.getByText('socket closed').props.selectable).toBe(false);
});
