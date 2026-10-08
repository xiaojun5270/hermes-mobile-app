import { render, screen } from '@testing-library/react-native';
import { CardButton } from '../src/components/card-button';
import { palettes } from '../src/theme';

const colors = palettes.light; // jest's color scheme — where the disabled primary was illegible

// Sim S1 §2 V6: at accessibility sizes the label touched the button's top and bottom edges.
test('V6: 44 pt minimum with vertical padding for large text', async () => {
  await render(<CardButton label="跳过" a11y="跳过" onPress={() => {}} />);
  expect(screen.getByRole('button', { name: '跳过' })).toHaveStyle({ minHeight: 44, paddingVertical: 8 });
});

test('an enabled primary is the accent with onAccent text', async () => {
  await render(<CardButton label="发送" a11y="发送" onPress={() => {}} primary />);
  expect(screen.getByRole('button', { name: '发送' })).toHaveStyle({ backgroundColor: colors.accent });
  expect(screen.getByText('发送')).toHaveStyle({ color: colors.onAccent });
});

// Sim S1 §2 V7: white onAccent on a 45%-opacity accent was low contrast in light.
test('V7: a disabled primary drops the accent for a legible surface + secondary text, not faded white', async () => {
  await render(<CardButton label="发送" a11y="发送" onPress={() => {}} primary disabled />);
  const button = screen.getByRole('button', { name: '发送' });
  expect(button).toBeDisabled();
  expect(button).toHaveStyle({ backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, opacity: 1 });
  expect(screen.getByText('发送')).toHaveStyle({ color: colors.textDim });
});
