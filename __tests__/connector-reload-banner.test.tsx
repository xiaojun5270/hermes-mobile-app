import { fireEvent, render, screen } from '@testing-library/react-native';
import { ConnectorReloadBanner } from '../src/components/connector-reload-banner';
import { palettes } from '../src/theme';

const colors = palettes.light;
const noop = () => {};

test('says the agent does not have the changes and offers 立即重新加载', async () => {
  const onReload = jest.fn();
  await render(<ConnectorReloadBanner running={false} disabledReason={null} note={null} onReload={onReload} />);
  expect(screen.getByText('智能体尚未加载你的修改。')).toBeTruthy();
  const button = screen.getByRole('button', { name: '立即重新加载' });
  expect(button).not.toBeDisabled();
  await fireEvent.press(button);
  expect(onReload).toHaveBeenCalledTimes(1);
});

test('when it cannot run, the button is disabled and the reason is shown', async () => {
  await render(
    <ConnectorReloadBanner running={false} disabledReason="请等待当前任务结束。" note={null} onReload={noop} />,
  );
  expect(screen.getByRole('button', { name: '立即重新加载' })).toBeDisabled();
  expect(screen.getByText('请等待当前任务结束。')).toBeTruthy();
});

test('while reloading the button is disabled and says so', async () => {
  await render(<ConnectorReloadBanner running disabledReason={null} note={null} onReload={noop} />);
  expect(screen.getByRole('button', { name: '立即重新加载' })).toBeDisabled();
  expect(screen.getByText('正在重新加载…')).toBeTruthy();
});

test('an error note is shown in the danger colour', async () => {
  await render(
    <ConnectorReloadBanner running={false} disabledReason={null} note={{ tone: 'error', text: 'compute-host reload failed' }} onReload={noop} />,
  );
  expect(screen.getByText('compute-host reload failed')).toHaveStyle({ color: colors.danger });
});
