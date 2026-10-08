import { render, screen } from '@testing-library/react-native';
import { VAULT_DECLINED_TEXT, VaultDeclinedNote } from '../src/components/vault-declined-note';

jest.mock('../src/components/icon', () => ({ Icon: () => null }));

test('the vault note says it was declined on the phone (review m12)', async () => {
  expect(VAULT_DECLINED_TEXT).toBe('Hermes 请求操作密码管理器，手机端已拒绝。');
  await render(<VaultDeclinedNote />);
  expect(screen.getByText(VAULT_DECLINED_TEXT)).toBeOnTheScreen();
});
