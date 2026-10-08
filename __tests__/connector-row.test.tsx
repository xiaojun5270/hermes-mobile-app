import { fireEvent, render, screen } from '@testing-library/react-native';
import type { McpServer } from '../src/api/mcp';
import { ConnectorRow } from '../src/components/connector-row';
import { palettes } from '../src/theme';

const colors = palettes.light; // jest's colour scheme

function server(over: Partial<McpServer> = {}): McpServer {
  return {
    name: 'linear',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    command: null,
    args: [],
    env: {},
    auth: 'oauth',
    enabled: true,
    tools: null,
    source: 'config',
    plugin: null,
    ...over,
  };
}

const noop = () => {};

test('shows the name, host, auth badge and status line', async () => {
  await render(<ConnectorRow server={server()} status='已连接 · 12 个工具' onPress={noop} onToggle={noop} />);
  expect(screen.getByText('linear')).toBeTruthy();
  expect(screen.getByText('mcp.linear.app')).toBeTruthy();
  expect(screen.getByText('OAuth')).toBeTruthy();
  expect(screen.getByText('已连接 · 12 个工具')).toHaveStyle({ color: colors.textDim });
});

test('a failed status is shown in the danger colour', async () => {
  await render(<ConnectorRow server={server()} status="失败" onPress={noop} onToggle={noop} />);
  expect(screen.getByText('失败')).toHaveStyle({ color: colors.danger });
});

test('no status line when status is unavailable', async () => {
  await render(<ConnectorRow server={server()} status={null} onPress={noop} onToggle={noop} />);
  expect(screen.queryByText(/已连接|失败|尚未加载/)).toBeNull();
});

test('a local server shows its command and the Local badge', async () => {
  const local = server({ name: 'yt', transport: 'stdio', url: null, command: 'uvx', args: ['mcp-yt'], auth: null });
  await render(<ConnectorRow server={local} status={null} onPress={noop} onToggle={noop} />);
  expect(screen.getByText('uvx mcp-yt')).toBeTruthy();
  expect(screen.getByText('本地')).toBeTruthy();
});

test('the switch reflects enabled and reports a toggle', async () => {
  const onToggle = jest.fn();
  const s = server({ enabled: false });
  await render(<ConnectorRow server={s} status={null} onPress={noop} onToggle={onToggle} />);
  const sw = screen.getByRole('switch');
  expect(sw.props.accessibilityLabel).toBe('linear 已停用，双击启用');
  expect(sw.props.value).toBe(false);
  fireEvent(sw, 'valueChange', true);
  expect(onToggle).toHaveBeenCalledWith(s);
});

test('the enabled switch uses a Chinese state label and preserves the server name', async () => {
  await render(<ConnectorRow server={server()} status={null} onPress={noop} onToggle={noop} />);
  expect(screen.getByRole('switch', { name: 'linear 已启用，双击停用' })).toBeTruthy();
});

test('a plugin server has no switch', async () => {
  await render(<ConnectorRow server={server({ source: 'plugin', plugin: 'p' })} status={null} onPress={noop} onToggle={noop} />);
  expect(screen.queryByRole('switch')).toBeNull();
  expect(screen.getByText('插件')).toBeTruthy();
});

test('a name the gateway routes cannot address says so and has no switch', async () => {
  await render(<ConnectorRow server={server({ name: 'a/b' })} status={null} onPress={noop} onToggle={noop} />);
  expect(screen.getByText('名称包含“/”，无法在应用中修改。')).toBeTruthy();
  expect(screen.queryByRole('switch')).toBeNull();
});

test('pressing the row opens it', async () => {
  const onPress = jest.fn();
  const s = server();
  await render(<ConnectorRow server={s} status={null} onPress={onPress} onToggle={noop} />);
  fireEvent.press(screen.getByRole('button', { name: /linear 连接器/ }));
  expect(onPress).toHaveBeenCalledWith(s);
});

test('a long name and URL are truncated to one line each, so the switch keeps its place (review focus 4)', async () => {
  const long = server({ name: 'a-very-long-connector-name-'.repeat(4), url: `https://${'sub.'.repeat(20)}example.com/mcp` });
  await render(<ConnectorRow server={long} status={null} onPress={noop} onToggle={noop} />);
  expect(screen.getByText(long.name).props.numberOfLines).toBe(1);
  expect(screen.getByText(`${'sub.'.repeat(20)}example.com`).props.numberOfLines).toBe(1);
  expect(screen.getByText(long.name)).toHaveStyle({ flexShrink: 1 });
  expect(screen.getByRole('switch')).toBeTruthy();
});

test('the accessibility label carries the state', async () => {
  await render(<ConnectorRow server={server({ enabled: false })} status="已关闭" onPress={noop} onToggle={noop} />);
  expect(screen.getByRole('button', { name: 'linear 连接器, mcp.linear.app, OAuth, 已关闭, 已停用' })).toBeTruthy();
});

test('the accessibility label also says when a connector cannot be changed', async () => {
  await render(<ConnectorRow server={server({ name: 'a/b', auth: null })} status={null} onPress={noop} onToggle={noop} />);
  expect(
    screen.getByRole('button', { name: 'a/b 连接器, mcp.linear.app, 无法在应用中修改' }),
  ).toBeTruthy();
});
