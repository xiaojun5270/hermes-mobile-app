// Sidebar navigation from a new chat. A new chat mints its session on the first message but keeps
// the /chat/new URL, so the sidebar resolves the chat on screen with the draft the screen published
// (draft-chat-store): New chat skips only an unstarted draft, and the started draft's own Recents
// row is already on screen.
import { Stack, useLocalSearchParams } from 'expo-router';
import { act, fireEvent, renderRouter, screen } from 'expo-router/testing-library';
import { useEffect } from 'react';
import { Text } from 'react-native';
import { Sidebar } from '../src/components/sidebar';
import { __resetDraftChatStore, setStartedDraft } from '../src/draft-chat-store';

jest.mock('../src/components/icon', () => ({ Icon: () => null }));
jest.mock('expo-haptics', () => ({ impactAsync: jest.fn(async () => {}), ImpactFeedbackStyle: { Light: 'light' } }));
jest.mock('../src/connection', () => ({
  withAuthRetry: jest.fn((fn: (r: unknown) => Promise<unknown>) =>
    fn({
      listSessions: async () => ({
        sessions: [
          { id: 's-draft', title: 'Ping test', preview: null, started_at: 1, last_active: 2, message_count: 2 },
        ],
        total: 1,
      }),
      get: async () => {
        throw new Error('not in this test');
      },
    }),
  ),
}));

// Each chat screen instance counts its mounts, so a remount (a real navigation) is observable
// even when the path does not change (/chat/new → /chat/new).
let mounts = 0;
function ChatStub() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useEffect(() => {
    mounts++;
  }, []);
  return (
    <>
      <Text>{`chat:${id}`}</Text>
      <Sidebar open width={300} />
    </>
  );
}

let pathname: () => string;
async function openChat(url: string) {
  mounts = 0;
  const rendered = renderRouter(
    { _layout: () => <Stack />, index: () => null, 'chat/[id]': ChatStub },
    { initialUrl: url },
  );
  pathname = () => rendered.getPathname();
  await rendered;
  await screen.findByText('Ping test'); // recents loaded
  expect(mounts).toBe(1);
}

beforeEach(() => __resetDraftChatStore());

test('sidebar navigation and search are simplified Chinese while user titles are unchanged', async () => {
  await openChat('/chat/new');
  expect(screen.getByLabelText('新建会话')).toBeOnTheScreen();
  expect(screen.getByPlaceholderText('搜索会话')).toBeOnTheScreen();
  expect(screen.getByLabelText('设置')).toBeOnTheScreen();
  expect(screen.getByText('Ping test')).toBeOnTheScreen();
});
test('新建会话 on an unstarted draft stays put', async () => {
  await openChat('/chat/new');
  await act(async () => fireEvent.press(screen.getByLabelText('新建会话')));
  expect(pathname()).toBe('/chat/new');
  expect(mounts).toBe(1);
});

test('新建会话 after the draft minted its session opens a fresh chat', async () => {
  await openChat('/chat/new');
  setStartedDraft('s-draft');
  await act(async () => fireEvent.press(screen.getByLabelText('新建会话')));
  expect(pathname()).toBe('/chat/new');
  expect(mounts).toBe(2);
});

test("the started draft's own Recents row is already on screen", async () => {
  await openChat('/chat/new');
  setStartedDraft('s-draft');
  await act(async () => fireEvent.press(screen.getByText('Ping test')));
  expect(pathname()).toBe('/chat/new');
  expect(mounts).toBe(1);
});

test('a Recents row opens that chat from an unstarted draft', async () => {
  await openChat('/chat/new');
  await act(async () => fireEvent.press(screen.getByText('Ping test')));
  expect(pathname()).toBe('/chat/s-draft');
});
