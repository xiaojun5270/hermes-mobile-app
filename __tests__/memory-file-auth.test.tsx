// Memory-file editor: a session that expires while there are unsaved edits. Save gets an
// AuthError and the screen sends you to sign in; the discard guard must not stand in the way
// ("Discard changes?" before login, where Keep editing strands you on a dead session).
import { Stack, router } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { Alert, Text } from 'react-native';
import { AuthError, HttpError } from '../src/api/restClient';
import MemoryFileScreen from '../src/app/memory-file';

jest.mock('../src/components/icon', () => ({ Icon: () => null }));
jest.mock('../src/components/markdown-view', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return { MarkdownView: ({ text }: { text: string }) => <RNText>{text}</RNText> };
});

// The first request (the file read) succeeds; every one after it (Save) finds the session gone.
const mockWithAuthRetry = jest.fn();
jest.mock('../src/connection', () => ({
  withAuthRetry: (...args: unknown[]) => mockWithAuthRetry(...args),
}));

const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

let pathname: () => string;

beforeEach(() => {
  alertSpy.mockClear();
  mockWithAuthRetry.mockReset();
  mockWithAuthRetry
    .mockResolvedValueOnce({ name: 'USER.md', content: 'old' })
    .mockRejectedValue(new AuthError('session expired'));
});

async function openFile() {
  const rendered = renderRouter(
    { _layout: () => <Stack />, index: () => <Text>sign in</Text>, 'memory-file': MemoryFileScreen },
    { initialUrl: '/' },
  );
  pathname = () => rendered.getPathname();
  await rendered;
  await act(async () => router.push('/memory-file?name=USER.md'));
  await screen.findByText('old');
}

async function editAndSave() {
  await openFile();
  await act(async () => fireEvent.press(screen.getByLabelText('编辑')));
  await act(async () => fireEvent.changeText(screen.getByLabelText('用户档案内容'), 'new'));
  await act(async () => fireEvent.press(screen.getByLabelText('保存')));
}

test('Save with unsaved edits and an expired session goes straight to sign-in', async () => {
  await editAndSave();

  expect(alertSpy).not.toHaveBeenCalled();
  expect(pathname()).toBe('/');
});

test('any other Save failure keeps the edits, and back still asks first', async () => {
  mockWithAuthRetry.mockReset();
  mockWithAuthRetry
    .mockResolvedValueOnce({ name: 'USER.md', content: 'old' })
    .mockRejectedValue(new HttpError(500, 'boom'));
  await editAndSave();
  expect(pathname()).toBe('/memory-file');
  expect(screen.getByLabelText('用户档案内容').props.value).toBe('new');

  await act(async () => router.back());
  expect(alertSpy).toHaveBeenCalledWith('放弃修改？', expect.any(String), expect.any(Array));
  expect(pathname()).toBe('/memory-file');
});
