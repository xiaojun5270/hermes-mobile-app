import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ActivityIndicator, AppState, FlatList, Keyboard, Pressable, Share, Text, View, type HostInstance } from 'react-native';
import Animated, { FadeIn, useAnimatedKeyboard, useAnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { createChatTransport, type ChatTransport } from '@/api/chat-transport';
import { RpcError, makeNativeSocket, type GatewayClient } from '@/api/gatewayClient';
import { getModelInfo } from '@/api/models';
import { clearStartedDraft, setStartedDraft } from '@/draft-chat-store';
import { clearSessionMcpTarget, createSessionMcpTarget, publishSessionMcpTarget } from '@/session-mcp-store';
import { setSessionModelTarget } from '@/session-model-store';
import { switchSessionModel, type SwitchOutcome } from '@/api/sessionModel';
import {
  ModelPillState,
  emptyModelPill,
  withFallbackModel,
  withResumedModel,
  withSessionModel,
  pillLabel,
  pillModelId,
} from '@/lib/model-pill';
import { withProfile } from '@/api/profiles';
import { listSkills } from '@/api/skills';
import type { GatewayEvent, GatewayEventMap, RpcMethods } from '@/vendor/hermes-gateway';
import { setAttachHandler } from '@/attach-bus';
import { ApprovalCard } from '@/components/approval-card';
import { ClarifyCard, type ClarifyResponder } from '@/components/clarify-card';
import { Icon } from '@/components/icon';
import { Composer } from '@/components/composer';
import { MessageQueue } from '@/components/message-queue';
import { MessageRow, type ChatItem, type ToolInfo } from '@/components/message-row';
import { SecureEntryCard } from '@/components/secure-entry-card';
import { SubagentMonitorCard } from '@/components/subagent-monitor-card';
import { ThinkingDots } from '@/components/thinking-dots';
import { TodoCard } from '@/components/todo-card';
import { VaultDeclinedNote } from '@/components/vault-declined-note';
import { connectionInfo, mintGatewayUrl, withAuthRetry } from '@/connection';
import { getProfileState, hydrateProfileStore } from '@/profile-store';
import { openSidebar } from '@/sidebar-store';
import { showActionSheet } from '@/lib/action-sheet';
import { exportAsJsonl, exportAsText } from '@/lib/export';
import { greetingForHour } from '@/lib/greeting';
import { historyToItems } from '@/lib/history';
import { afterKeyboardSettles } from '@/lib/keyboard-settle';
import { MAX_ATTACH_BYTES, base64ByteLength } from '@/lib/image-attach';
import { ChatOutbox } from '@/lib/chat-outbox';
import { ChatJournal } from '@/lib/chat-journal';
import { journalScope } from '@/lib/outgoing-journal';
import type { Draft } from '@/lib/outgoing';
import type { ReconnectOrchestrator, ReconnectPhase } from '@/lib/reconnect-orchestrator';
import { createRequestResponder, type RequestResponder } from '@/lib/request-answers';
import type { RequestRegistry } from '@/lib/request-registry';
import { shouldWarn } from '@/lib/request-router';
import { provenanceForCard, type SkillsLookup } from '@/lib/secure-entry';
import { emptyBatch, finalizeBatch, reduceSubagentEvent } from '@/lib/subagent-progress';
import { parseTodoList } from '@/lib/todo';
import { deniedSummary, toolOutcome } from '@/lib/tool-outcome';
import { shouldReconnect } from '@/lib/reconnect';
import {
  appendAfterStream,
  appendStoppedMarker,
  closeStreaming,
  createCardPinner,
  createItemsMirror,
  offsetToReveal,
  withCardAnchors,
  type CardAnchors,
} from '@/lib/transcript-rows';
import { completionEffects, createTurnCommands, type TurnCommands } from '@/lib/turn-commands';
import {
  completeStatus,
  composerMode,
  initialTurnModel,
  isApprovalActionable,
  mergeRequestRows,
  resumeRunning,
  type RequestCardState,
  type TranscriptRow,
  type TurnAction,
  type TurnModel,
} from '@/lib/turn-controller';
import { serif, useTheme } from '@/theme';

export { RouteError as ErrorBoundary } from '@/components/route-error';

// The gateway DEFAULT model id (from /api/model/info), cached module-level so
// the pill's fallback shows instantly on later chat mounts. Never a session
// model — each ChatScreen starts with session=null — so sharing it globally is
// safe; it only seeds the fallback slot, which pillLabel yields when no
// session model is known.
let cachedModelId: string | null = null;

const hasLiquidGlass = isLiquidGlassAvailable();

/** Floating circular header button — the header bar itself is hidden.
 * Native liquid glass on iOS 26+, a solid surface circle elsewhere. */
function HeaderButton({
  icon,
  label,
  onPress,
}: {
  icon: string;
  label: string;
  onPress: () => void;
}) {
  const { colors, dark } = useTheme();

  if (hasLiquidGlass) {
    return (
      <GlassView isInteractive style={{ borderRadius: 23, overflow: 'hidden' }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          hitSlop={4}
          onPress={onPress}
          style={{ width: 46, height: 46, alignItems: 'center', justifyContent: 'center' }}
        >
          <Icon sf={icon} size={19.5} color={colors.text} />
        </Pressable>
      </GlassView>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 46,
        height: 46,
        borderRadius: 23,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: pressed ? colors.raised : colors.surface,
        boxShadow: dark ? '0 2px 10px rgba(0, 0, 0, 0.35)' : '0 2px 10px rgba(31, 30, 26, 0.10)',
      })}
    >
      <Icon sf={icon} size={19.5} color={colors.text} />
    </Pressable>
  );
}

type Row = TranscriptRow<ChatItem>;

export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChatSession key={id} id={id} />;
}

function ChatSession({ id }: { id: string }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<ChatItem[]>([]);
  // Every transcript mutation goes through updateItems: the mirror applies it to the latest list and
  // is the request-card anchor at once, so a card never lands above the row that asked for it (M5).
  // A card's arrival closes the streaming segment (onNewCard), so the anchor is read after that close.
  const [itemsMirror] = useState(() => createItemsMirror<ChatItem>(setItems, closeStreaming));
  const updateItems = (fn: (prev: ChatItem[]) => ChatItem[]) => itemsMirror.update(fn);
  // Cards that were open across a history replace, drawn under the row that asked for them (final
  // review I1, D1). The pinner records them at the reload and pins them when the reconnect ends.
  const [cardAnchors, setCardAnchors] = useState<CardAnchors>({});
  const [cardPinner] = useState(createCardPinner);
  const [outbox] = useState(() => new ChatOutbox());
  const pending = useSyncExternalStore(outbox.subscribe, outbox.getSnapshot);
  const input = pending.draft.text;
  const stagedImage = pending.draft.image;
  const [thinking, setThinking] = useState(false); // sent / turn started, no tokens yet
  const [turn, setTurn] = useState<TurnModel>(initialTurnModel); // server-driven (spec §5.1)
  const [error, setError] = useState<string | null>(null);
  const [reconnectNote, setReconnectNote] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pill, setPill] = useState<ModelPillState>(() =>
    withFallbackModel(emptyModelPill(), cachedModelId),
  );
  const modelName = pillLabel(pill);
  const currentModelId = pillModelId(pill);
  const busy = turn.turn !== 'idle';
  // One transport per screen (spec §4.2): client + turn store + request router + reconnect
  // orchestrator, all handlers registered at construction, reused across reconnects.
  const transportRef = useRef<ChatTransport | null>(null);
  const registryRef = useRef<RequestRegistry | null>(null);
  const orchestratorRef = useRef<ReconnectOrchestrator | null>(null);
  const liveIdRef = useRef<string | null>(null); // gateway (live) session handle
  const storedIdRef = useRef<string | null>(null); // persistent id, survives reconnects
  const startedDraftRef = useRef<string | null>(null); // session a /chat/new minted (draft-chat-store)
  const cancelledRef = useRef(false);
  // Profile target captured at mount — keeps create/resume/history consistent
  // for this chat even if the user switches profiles elsewhere mid-session.
  const profileRef = useRef<string | null>(getProfileState().selected);
  const scopeRef = useRef<{ gateway: string; identity: string } | null>(null);
  const keyCounter = useRef(0);
  const activeSubagentKeyRef = useRef<string | null>(null);
  const todoKeyRef = useRef<string | null>(null);
  // Latest render's handlers, read by the transport's long-lived callbacks.
  const handlersRef = useRef<{
    applyEvent: (e: GatewayEvent) => void;
    loadHistory: (storedId: string) => Promise<void>;
    onPhase: (p: ReconnectPhase) => void;
    onNewCard: (card: RequestCardState, replayed: boolean) => void;
    pinCardsAfterSequence: () => void;
    accepted: (draft: Draft, status: 'streaming' | 'queued', key: string) => void;
    pickImage: (source: 'camera' | 'library') => Promise<void>;
  } | null>(null);

  const nextKey = () => `i${keyCounter.current++}`;
  // Names plan B builds on (contract R1).
  const gw = (): GatewayClient | null => transportRef.current?.client ?? null;
  const readTurn = (): TurnModel => transportRef.current?.store.getState() ?? initialTurnModel();
  const dispatchTurn = (a: TurnAction): void => transportRef.current?.store.dispatch(a);
  const resumeParams = () => withProfile({ session_id: storedIdRef.current ?? '' }, profileRef.current);

  /** Typed call on this screen's single client. A's `gw()` is null before mount/after unmount;
   *  this rejects (never throws synchronously) so command/answer code can treat it as a failure. */
  function callGw<M extends keyof RpcMethods>(
    method: M,
    params: RpcMethods[M]['params'],
  ): Promise<RpcMethods[M]['result']> {
    const client = gw();
    return client ? client.call(method, params) : Promise.reject(new RpcError('尚未连接。', -1));
  }

  // Stop / steer (spec §5.3). Created once, on first use from a handler (never during render —
  // its deps read refs, which the React Compiler forbids in render); every dep reads refs at call time.
  const commandsRef = useRef<TurnCommands | null>(null);
  function commands(): TurnCommands {
    commandsRef.current ??= createTurnCommands({
      call: callGw,
      dispatch: (a) => dispatchTurn(a),
      liveSessionId: () => liveIdRef.current,
      turnState: () => readTurn().turn,
      // A's transport: session.resume on the stored id, updates liveIdRef + seeds the store.
      resumeStored: () =>
        transportRef.current?.resumeStored() ?? Promise.reject(new RpcError('尚未连接。', -1)),
      reconnect: (trigger) => orchestratorRef.current?.reconnect(trigger) ?? Promise.resolve(),
      setTimer: (fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
    });
    return commandsRef.current;
  }
  // Unmount: cancel a pending 15 s stop fallback so it never reconnects a dead screen.
  useEffect(() => () => commandsRef.current?.dispose(), []);

  const listRef = useRef<FlatList<Row>>(null);
  // Request cards answer through one responder (spec §6). Created lazily from a handler, like
  // commands(): its deps read refs, which the React Compiler forbids in render.
  const responderRef = useRef<RequestResponder | null>(null);
  function responder(): RequestResponder {
    responderRef.current ??= createRequestResponder({
      // A's registry is null only before mount / after unmount → "no longer open".
      registry: {
        respond: (id, result) => registryRef.current?.respond(id, result) ?? false,
        drop: (id) => registryRef.current?.drop(id),
      },
      call: callGw,
      dispatch: (a) => dispatchTurn(a),
      liveSessionId: () => liveIdRef.current,
      current: (id) => readTurn().requests.find((r) => r.id === id),
    });
    return responderRef.current;
  }
  // ClarifyCard calls these only from its handlers, so render never builds the responder.
  const clarifyResponder: ClarifyResponder = {
    clarifySingle: (card, answer) => responder().clarifySingle(card, answer),
    clarifyLock: (card, qid, answer) => responder().clarifyLock(card, qid, answer),
    clarifySubmitAll: (card, answers) => responder().clarifySubmitAll(card, answers),
    clarifySkipAll: (card) => responder().clarifySkipAll(card),
  };

  // Provenance for pending secret cards: one lookup per new card set, scoped to this chat's profile.
  // Failure → "unknown" (spec §6.4). Keyed by card ids so a just-created skill is found; each card
  // then reads the lookup that covers it (provenanceForCard), so settling never resets it.
  const pendingSecretIds = turn.requests
    .filter((r) => r.method === 'secret' && r.status === 'pending')
    .map((r) => r.id)
    .join(',');
  const [skills, setSkills] = useState<SkillsLookup | null>(null);
  useEffect(() => {
    if (!pendingSecretIds) return;
    let stale = false;
    const ids = pendingSecretIds.split(',');
    withAuthRetry((r) => listSkills(r, profileRef.current))
      .then((list) => !stale && setSkills({ ids, list }))
      .catch(() => !stale && setSkills({ ids, list: null }));
    return () => {
      stale = true;
    };
  }, [pendingSecretIds]);

  async function stop() {
    try { await outbox.pause(); }
    catch { return; } // Outbox already reports the storage error; don't interrupt before durable pause.
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    const out = await commands().stop();
    if (!out.ok) setError(out.message);
  }

  async function steer() {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    if (readTurn().turn === 'idle') { outbox.setError('当前任务已空闲，请发送或加入队列。'); return; }
    await outbox.steer();
  }

  function accepted(draft: Draft, status: 'streaming' | 'queued', key: string) {
    if (cancelledRef.current) return;
    const row: ChatItem = {
      key: nextKey(), role: 'user', text: draft.text, complete: true,
      files: draft.files.map((f) => ({ name: f.name, size: f.size })),
      ...(key.startsWith('steer-') ? { steered: true } : {}),
      ...(draft.image ? { imageUri: draft.image.uri, imageWidth: draft.image.width, imageHeight: draft.image.height } : {}),
    };
    updateItems((prev) => appendAfterStream(prev, row));
    if (status === 'streaming') {
      dispatchTurn({ type: 'submit.sent' });
      setThinking(true);
    }
  }

  function append(role: ChatItem['role'], text: string, complete = true) {
    updateItems((prev) => [...prev, { key: nextKey(), role, text, complete }]);
  }

  /** Append streamed text to the trailing assistant message (create if absent). */
  function appendDelta(text: string) {
    setThinking(false);
    updateItems((prev) => {
      const last = prev[prev.length - 1];
      if (last?.role === 'assistant' && !last.complete) {
        return [...prev.slice(0, -1), { ...last, text: last.text + text }];
      }
      return [...prev, { key: nextKey(), role: 'assistant', text, complete: false }];
    });
  }

  /** Close the trailing streaming segment: complete it, or drop it if it
   * holds only whitespace (prevents stranded carets around tool calls). */
  function finishAssistant() {
    updateItems(closeStreaming);
  }

  function startTool(payload: any) {
    const tool: ToolInfo = {
      id: String(payload?.tool_id ?? `t${keyCounter.current}`),
      name: String(payload?.name ?? 'tool'),
      ...(payload?.context ? { context: String(payload.context) } : {}),
      running: true,
    };
    updateItems((prev) => [...prev, { key: nextKey(), role: 'tool', text: tool.name, tool }]);
  }

  function completeTool(payload: any) {
    const tid = String(payload?.tool_id ?? '');
    updateItems((prev) => {
      let idx = prev.findIndex((it) => it.tool?.running && it.tool.id === tid);
      if (idx < 0) {
        for (let i = prev.length - 1; i >= 0; i--) {
          if (prev[i].tool?.running && prev[i].tool!.name === String(payload?.name ?? '')) {
            idx = i;
            break;
          }
        }
      }
      if (idx < 0) return prev;
      const result = payload?.result;
      const rawDetail =
        typeof payload?.result_text === 'string' && payload.result_text
          ? payload.result_text
          : typeof result === 'string'
            ? result
            : result !== undefined && result !== null
              ? JSON.stringify(result, null, 2)
              : '';
      const outcome = toolOutcome(result);
      // A denial's own words ("You denied this command — it did not run.") when the gateway sent none.
      const summary = payload?.summary ? String(payload.summary) : outcome === 'denied' ? deniedSummary(result) : undefined;
      const tool: ToolInfo = {
        ...prev[idx].tool!,
        running: false,
        ...(typeof payload?.duration_s === 'number' ? { durationS: payload.duration_s } : {}),
        ...(summary ? { summary } : {}),
        ...(outcome !== 'ok' ? { outcome } : {}),
        ...(rawDetail ? { detail: rawDetail.slice(0, 4000) } : {}),
        ...(payload?.inline_diff ? { diff: String(payload.inline_diff).slice(0, 4000) } : {}),
      };
      const next = [...prev];
      next[idx] = { ...prev[idx], tool };
      return next;
    });
  }

  /** Reduce a `subagent.*` event into the active batch item (create one if the
   * last batch finalized / none exists). */
  function handleSubagentEvent(e: GatewayEvent) {
    const ts = Date.now();
    const sub = { type: e.type, payload: e.payload as Record<string, unknown> | undefined };
    updateItems((prev) => {
      const k = activeSubagentKeyRef.current;
      const idx = k ? prev.findIndex((it) => it.key === k) : -1;
      if (idx >= 0 && prev[idx].subagent && !prev[idx].subagent!.finalized) {
        const next = [...prev];
        next[idx] = { ...prev[idx], subagent: reduceSubagentEvent(prev[idx].subagent!, sub, ts) };
        return next;
      }
      const key = nextKey();
      activeSubagentKeyRef.current = key;
      return [...prev, { key, role: 'subagent', text: '', subagent: reduceSubagentEvent(emptyBatch(), sub, ts) }];
    });
    if (e.type === 'subagent.complete' && !e.replayed) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    }
  }

  /** Turn ended / interrupted: stop any still-running subagents and seal the card. */
  function finalizeSubagents() {
    const k = activeSubagentKeyRef.current;
    if (!k) return;
    activeSubagentKeyRef.current = null;
    updateItems((prev) => prev.map((it) => (it.key === k && it.subagent ? { ...it, subagent: finalizeBatch(it.subagent) } : it)));
  }

  /** Update (or create) the single todo card from a `todo` tool.complete.
   * Returns false when the payload carried no list (e.g. an internal tool_error),
   * so the caller can surface the failure instead of dropping it silently. */
  function upsertTodo(payload: any): boolean {
    const list = parseTodoList(payload);
    if (list === null) return false;
    updateItems((prev) => {
      const k = todoKeyRef.current;
      const idx = k ? prev.findIndex((it) => it.key === k) : -1;
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = { ...prev[idx], todo: list };
        return next;
      }
      const key = nextKey();
      todoKeyRef.current = key;
      return [...prev, { key, role: 'todo', text: '', todo: list }];
    });
    return true;
  }

  async function loadHistory(storedId: string) {
    const history = await withAuthRetry((r) => r.getMessages(storedId, profileRef.current ?? undefined));
    if (cancelledRef.current) return;
    const reloaded = historyToItems(history.messages, nextKey);
    updateItems(() => reloaded);
    // The reload re-keyed every row, so a card open now lost its anchor. It is NOT pinned here: the
    // replay that follows appends the running tool row that asked for it, and a pin under the reloaded
    // last row put the card above that row (D1). Recorded instead, it draws at the tail until the
    // sequence ends (onPhase), then is pinned under its requester row, so it is still drawn once it
    // settles (final review I1). Settled cards are in the history (contract §8). Every pre-reload key
    // is dead after the re-key, so no override survives: none are passed.
    const requests = readTurn().requests;
    setCardAnchors(cardPinner.onHistoryReplace(requests, {}, reloaded));
    // historyToItems never emits subagent/todo rows; clear stale live-card keys
    // so a reconnect/history replace can't update a row that no longer exists.
    // Request cards live in the turn store, NOT in items, so they survive this replace.
    activeSubagentKeyRef.current = null;
    todoKeyRef.current = null;
  }

  /** The reconnect sequence ended (ready, failed, or start() rejected): pin the cards the pinner
   *  recorded under their requester rows (D1). Inputs are read here, not in the updater (finding 7). */
  function pinCardsAfterSequence() {
    const pins = cardPinner.onSequenceEnd(readTurn().requests, itemsMirror.items(), itemsMirror.anchorKey());
    if (pins) setCardAnchors((prev) => ({ ...prev, ...pins }));
  }

  function onPhase(p: ReconnectPhase) {
    if (cancelledRef.current) return;
    if (p.kind === 'attempt') {
      cardPinner.sequenceStarted();
      setReady(false);
      // A subagent card is NOT sealed here: when the replay ring no longer reaches the turn's
      // anchor, the reconnect keeps the screen and the gap's subagent.* events continue the same
      // card (A1). It is sealed below once we know the turn is over or the reconnect gave up.
      setReconnectNote(`连接中断，正在重连（${p.attempt}/${p.max})…`);
    } else if (p.kind === 'ready') {
      pinCardsAfterSequence();
      // A turn that finished while the socket was down never delivers message.complete
      // (resume reports running:false, replay is skipped) — drop the stale thinking flag.
      if (readTurn().turn === 'idle') {
        setThinking(false);
        finalizeSubagents(); // socket drop mid-delegation, turn over: seal the card
      }
      setReconnectNote(null);
      setError(null);
      setReady(true);
    } else {
      pinCardsAfterSequence();
      finalizeSubagents(); // gave up: nothing will update the card again
      setReconnectNote(null);
      setError('重连失败，请检查 VPN 或 Wi-Fi 后重新打开会话。');
    }
  }

  /** A request card appeared (live or replayed): close the streaming segment so later text
   * renders after the card; warn only for live arrivals (replays never fire haptics). */
  function onNewCard(card: RequestCardState, replayed: boolean) {
    // A card first delivered mid-reconnect anchors before the replayed row that asked for it (review
    // finding 5): the pinner moves it under that row when the sequence ends.
    if (cardPinner.inSequence()) cardPinner.onCardCreatedDuringSequence(card.id);
    setThinking(false);
    finishAssistant();
    // Live arrivals only, and not vault prompts — those are declined on arrival (spec §6.3),
    // so there is nothing to answer and no "needs you" haptic.
    if (shouldWarn(card, replayed)) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    }
  }

  /** Transcript side of every gateway event (live and replayed). The transport has already
   * updated the turn store (message.start/complete/error) and consumed request events. */
  function applyEvent(e: GatewayEvent) {
    const live = !e.replayed;
    switch (e.type) {
      case 'message.start':
        setThinking(true);
        if (live) void outbox.sync();
        break;
      case 'message.delta':
        appendDelta((e.payload as GatewayEventMap['message.delta'] | undefined)?.text ?? '');
        break;
      case 'message.complete': {
        const p = e.payload as GatewayEventMap['message.complete'] | undefined;
        const status = completeStatus(p);
        setThinking(false);
        updateItems((prev) => {
          const last = prev[prev.length - 1];
          const text = typeof p?.text === 'string' ? p.text : '';
          if (p?.response_previewed || !text?.trim()) return closeStreaming(prev);
          if (last?.role === 'assistant' && !last.complete) return [...prev.slice(0, -1), { ...last, text, complete: true }];
          return [...prev, { key: nextKey(), role: 'assistant', text, complete: true }];
        });
        finalizeSubagents();
        const fx = completionEffects(status, !live);
        if (fx.stoppedMarker) {
          const marker: ChatItem = { key: nextKey(), role: 'status', text: '已停止', marker: 'stopped' };
          updateItems((prev) => appendStoppedMarker(prev, marker));
        } else if (status === 'error') {
          setError(p?.error || '本轮任务失败。');
        }
        if (fx.successHaptic) void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
        if (live) void outbox.sync();
        break;
      }
      case 'message.interim': {
        const p = e.payload as GatewayEventMap['message.interim'] | undefined;
        finishAssistant();
        if (typeof p?.text === 'string' && p.text && !p.already_streamed) append('assistant', p.text);
        break;
      }
      case 'tool.start': {
        const p = e.payload as GatewayEventMap['tool.start'] | undefined;
        setThinking(false);
        finishAssistant();
        if (p?.name === 'todo') break; // todo renders as TodoCard on complete
        startTool(p);
        break;
      }
      case 'tool.complete': {
        const p = e.payload as GatewayEventMap['tool.complete'] | undefined;
        if (p?.name === 'todo') {
          if (!upsertTodo(p)) append('status', '待办更新失败');
          break;
        }
        completeTool(p);
        break;
      }
      case 'status.update': {
        const p = e.payload as GatewayEventMap['status.update'] | undefined;
        if (p?.text) append('status', p.text);
        break;
      }
      case 'subagent.spawn_requested':
      case 'subagent.start':
      case 'subagent.thinking':
      case 'subagent.tool':
      case 'subagent.progress':
      case 'subagent.complete':
        handleSubagentEvent(e);
        break;
      case 'session.info': {
        const p = e.payload as GatewayEventMap['session.info'] | undefined;
        if (p?.model) {
          const m = p.model;
          setPill((prev) => withSessionModel(prev, m));
        }
        break;
      }
      case 'error': {
        // "Outside a turn" at 0.21.5: ends the turn only while waiting (the store already
        // decided); in streaming it is an inline notice and the turn continues (review M6).
        const p = e.payload as GatewayEventMap['error'] | undefined;
        setThinking(false);
        if (readTurn().turn === 'idle') finalizeSubagents();
        setError(p?.message ?? '智能体出错');
        break;
      }
    }
  }

  /** Photo picking — staged locally, uploaded via image.attach_bytes on send. */
  async function pickImage(source: 'camera' | 'library') {
    await outbox.pickImage(async () => {
      if (source === 'camera') {
        const perm = await ImagePicker.requestCameraPermissionsAsync();
        if (!perm.granted) {
          throw new Error('相机权限未开启，请在系统设置中启用后拍照。');
        }
      }
      const options: ImagePicker.ImagePickerOptions = {
        mediaTypes: ['images'],
        base64: true,
        quality: 0.7,
        exif: false,
      };
      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync(options)
          : await ImagePicker.launchImageLibraryAsync(options);
      if (result.canceled) return null;
      const asset = result.assets[0];
      if (!asset?.base64) {
        throw new Error('无法读取图片，请选择其他图片。');
      }
      if (base64ByteLength(asset.base64) > MAX_ATTACH_BYTES) {
        throw new Error('图片超过 25 MB，网关无法接收。');
      }
      return {
        uri: asset.uri,
        base64: asset.base64,
        fileName: asset.fileName,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
      };
    });
  }

  // Keep the transport's long-lived callbacks pointed at this render's closures.
  // Declared BEFORE the mount effect so it runs first.
  useEffect(() => {
    handlersRef.current = { applyEvent, loadHistory, onPhase, onNewCard, pinCardsAfterSequence, accepted, pickImage };
  });

  useEffect(() => {
    cancelledRef.current = false;
    const t = createChatTransport({
      socketFactory: makeNativeSocket,
      mintUrl: mintGatewayUrl,
      storedSessionId: () => storedIdRef.current,
      resumeParams: () => resumeParams(),
      loadHistory: (sid) => handlersRef.current!.loadHistory(sid),
      onLiveSessionId: (liveId) => {
        liveIdRef.current = liveId;
        // Best-effort: re-bind this device to the session (live id changes on
        // resume) so session-stop push hooks can target it. Never block the flow.
        void withAuthRetry((r) => r.claimSession(liveId, storedIdRef.current ?? liveId)).catch(() => {});
      },
      // Only adopt a built (non-lazy) resume's model — a lazy reattach reports the gateway
      // default, and an info-less resume omits it; neither may clobber the known model.
      onResumed: (res) => {
        setPill((p) => withResumedModel(p, res.info));
        outbox.seed(res);
      },
      onPhase: (p) => handlersRef.current?.onPhase(p),
      applyEvent: (e) => handlersRef.current?.applyEvent(e),
      anchorKey: () => itemsMirror.anchorKey(),
      onNewCard: (card, replayed) => handlersRef.current?.onNewCard(card, replayed),
    });
    transportRef.current = t;
    registryRef.current = t.registry;
    orchestratorRef.current = t.orchestrator;
    outbox.configure({
      connected: () => t.client.isOpen && !cancelledRef.current,
      liveSession: () => liveIdRef.current,
      call: (method, params) => t.client.call(method, params),
      ensureSession: async () => {
        if (!liveIdRef.current) {
          const created = await t.client.call('session.create', withProfile({}, profileRef.current));
          liveIdRef.current = created.session_id;
          storedIdRef.current = created.stored_session_id ?? created.session_id;
          setPill((p) => withResumedModel(p, created.info));
          if (id === 'new') {
            startedDraftRef.current = storedIdRef.current;
            setStartedDraft(storedIdRef.current);
          }
          const scope = scopeRef.current;
          if (scope) await outbox.migrate(new ChatJournal(journalScope(scope.gateway, scope.identity, profileRef.current, storedIdRef.current)), storedIdRef.current);
          void withAuthRetry((r) => r.claimSession(created.session_id, storedIdRef.current!)).catch(() => {});
        }
        return liveIdRef.current;
      },
      snapshot: async () => {
        // activate addresses a live runtime; resume addresses the stored conversation.
        const params: RpcMethods['session.activate']['params'] = withProfile({
          session_id: liveIdRef.current!, omit_messages: true,
        }, profileRef.current);
        const res = await t.client.call('session.activate', params);
        liveIdRef.current = res.session_id;
        // Same request-card withdrawal/Stop preservation rule as reconnect seeding.
        t.store.dispatch({ type: 'resume.seeded', running: resumeRunning(res), openRequestIds: res.open_requests?.map((r) => r.id) });
        return res;
      },
      accepted: (draft, status, key) => handlersRef.current?.accepted(draft, status, key),
    });
    setTurn(t.store.getState());
    const unsubStore = t.store.subscribe(() => setTurn(t.store.getState()));
    // Foreground triggers are held off until start() owns the single-flight slot (PR #22
    // hold-off, review M2): before that, hydrate + first-paint history are still running and a
    // reconnect would flash "Connection lost" and back off for nothing.
    let started = false;
    (async () => {
      try {
        await hydrateProfileStore(); // no-op when sessions screen already ran
        profileRef.current = getProfileState().selected;
        const info = await connectionInfo();
        if (!info) throw new Error('尚未连接网关。');
        scopeRef.current = { gateway: info.baseUrl, identity: info.deviceId ?? info.username };
        const restoredId = await outbox.initialize(new ChatJournal(journalScope(info.baseUrl, info.deviceId ?? info.username, profileRef.current, id)));
        if (restoredId) storedIdRef.current = restoredId;
        let historyLoaded = false;
        if (id !== 'new') {
          storedIdRef.current = id;
          try {
            await handlersRef.current!.loadHistory(id); // fast first paint, before the socket
            historyLoaded = true;
          } catch {
            // start() loads it instead, after resume
          }
        }
        // connect → resume → history (spec §7). The first paint above already replaced the
        // transcript, so the initial run skips a second load that would re-key and re-fade
        // every row (review I1); reconnects still reload.
        started = true;
        cardPinner.sequenceStarted();
        await t.orchestrator.start({ historyLoaded });
      } catch {
        if (!cancelledRef.current) {
          // start() never reports `failed`: a card its history load recorded is pinned here (finding 6).
          handlersRef.current?.pinCardsAfterSequence();
          setError('无法打开会话，请检查 VPN 或 Wi-Fi。');
        }
      }
    })();
    // Foreground revival: iOS suspends the runtime and the OS tears the socket
    // down without a close event. On return, if the socket is not OPEN, run the
    // single-flight reconnect (it joins a heartbeat/close-triggered run).
    const sub = AppState.addEventListener('change', (next) => {
      if (cancelledRef.current || !started) return;
      if (next !== 'active') void outbox.save().catch(() => {});
      if (next === 'active' && t.client.isOpen) void outbox.sync();
      if (shouldReconnect({ hasSocket: true, isOpen: t.client.isOpen, appState: next })) {
        // May join a failing start(): its caller already reports that failure (review M1).
        t.orchestrator.reconnect('foreground').catch(() => {});
      }
    });
    return () => {
      cancelledRef.current = true;
      outbox.dispose();
      clearStartedDraft(startedDraftRef.current);
      sub.remove();
      unsubStore();
      t.dispose(); // orchestrator first, then the socket — no reconnect on unmount
      if (transportRef.current === t) {
        transportRef.current = null;
        registryRef.current = null;
        orchestratorRef.current = null;
      }
    };
  }, [id, itemsMirror, cardPinner, outbox]); // owners are stable (useState)

  const polling = pending.polling;
  useEffect(() => {
    if (!ready || !polling) return;
    const timer = setInterval(() => void outbox.sync(), 1500);
    void outbox.sync();
    return () => clearInterval(timer);
  }, [ready, polling, outbox]);

  // Composer model pill — best-effort, never blocks the chat.
  useEffect(() => {
    let stale = false;
    withAuthRetry((r) => getModelInfo(r))
      .then((info) => {
        cachedModelId = info.model;
        if (!stale) setPill((p) => withFallbackModel(p, info.model));
      })
      .catch(() => {
        // offline or older server — pill simply stays hidden
      });
    return () => {
      stale = true;
    };
  }, []);

  // Publish this chat's switch target so the /models picker (session mode) can
  // switch THIS chat over its live socket. Re-keyed on `id` so navigating
  // between chats clears the prior target and republishes for the active one;
  // the switchModel closure also reads the refs at call time, so the switch
  // always lands on the live session even within a re-establish window.
  useEffect(() => {
    setSessionModelTarget({
      sessionId: liveIdRef.current ?? '',
      modelId: currentModelId,
      streaming: busy,
      switchModel: (provider, model, confirmExpensive) => {
        const t = transportRef.current;
        const sid = liveIdRef.current;
        if (!t || !sid) {
          return Promise.resolve({ kind: 'error', message: '尚未连接。' } as SwitchOutcome);
        }
        return switchSessionModel(t.client.call.bind(t.client), {
          sessionId: sid,
          provider,
          model,
          confirmExpensive,
          resumeSession: () => t.resumeStored(), // 4001 → resume + retry once
        });
      },
    });
    return () => setSessionModelTarget(null);
  }, [id, currentModelId, busy, ready]);

  // Lend this chat's socket to the Connectors screens (test, runtime status, reload).
  // One identity per mounted chat screen: the store shows the newest mounted chat,
  // so an overlap during a route transition cannot hide or clear the live one.
  const [mcpOwner] = useState(() => ({}));
  useEffect(() => {
    publishSessionMcpTarget(
      mcpOwner,
      createSessionMcpTarget({
        connected: ready,
        streaming: busy,
        getCall: () => {
          const t = transportRef.current;
          return t ? t.client.call.bind(t.client) : null;
        },
        getSessionId: () => liveIdRef.current,
      }),
    );
  }, [mcpOwner, ready, busy]);
  useEffect(() => () => clearSessionMcpTarget(mcpOwner), [mcpOwner]);

  // The add-to-chat sheet (its own formSheet route) fires camera/library
  // requests over the attach bus once it has dismissed itself.
  useEffect(() => setAttachHandler((action) => void (action === 'files' ? outbox.pickFiles() : handlersRef.current?.pickImage(action))), [outbox]);

  /** Share the current conversation via the system share sheet. */
  async function shareExport(format: 'text' | 'jsonl') {
    try {
      const message = format === 'text' ? exportAsText(items) : exportAsJsonl(items);
      if (!message) return;
      await Share.share({ message });
    } catch {
      // user dismissed the share sheet or sharing is unavailable — not an error
    }
  }

  function showExportSheet() {
    if (items.length === 0) return;
    showActionSheet('导出会话', [
      { label: '文本', onPress: () => void shareExport('text') },
      { label: 'JSONL', onPress: () => void shareExport('jsonl') },
    ]);
  }

  async function send() {
    const t = transportRef.current;
    // Server-driven turn state: sending is only possible from idle (plan B adds steer).
    if (!t?.client.isOpen || readTurn().turn !== 'idle') return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setError(null);
    await outbox.send();
  }

  // Request cards live in the turn store (outside items) and merge in after their anchor.
  const rows = useMemo(
    () => mergeRequestRows(items, withCardAnchors(turn.requests, cardAnchors)),
    [items, turn.requests, cardAnchors],
  );
  // Inverted list: index 0 renders at the visual bottom, so newest goes first.
  const reversedRows = useMemo(() => [...rows].reverse(), [rows]);
  // Room kept under the floating header buttons: the list's visual-top padding, and the top of the
  // band a focused card field is scrolled into.
  const headerClearance = insets.top + 64;

  // Focusing a card's text field: once the keyboard has finished rising (its inset, containerStyle
  // paddingBottom, is then final — a fixed timer fired mid-rise, sim S3 s1), scroll the FIELD into the
  // band between the header and the composer — a tall card's field is off-screen whichever card edge
  // is aligned (sim S2 B2). Everything is measured then, so rows that changed meanwhile can't skew it
  // (m2). One pending scroll; cancelled on unmount.
  const scrollOffsetRef = useRef(0);
  // While a card field has the keyboard, a tap on a card button acts at once instead of only dismissing
  // the keyboard (sim S3 s2): the list persists taps its rows handle. With the composer's keyboard it
  // stays 'never', so a tap on a message row still just dismisses the keyboard, as before.
  const [cardFieldFocused, setCardFieldFocused] = useState(false);
  useEffect(() => {
    const sub = Keyboard.addListener('keyboardDidHide', () => setCardFieldFocused(false));
    return () => sub.remove();
  }, []);
  const cancelRevealRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRevealRef.current?.(), []);
  function revealField(measureField: HostInstance['measureInWindow']) {
    setCardFieldFocused(true);
    cancelRevealRef.current?.();
    cancelRevealRef.current = afterKeyboardSettles(Keyboard, () => {
      cancelRevealRef.current = null;
      const list = listRef.current?.getNativeScrollRef();
      if (!list || !('measureInWindow' in list)) return; // unmounted; FlatList's ref type is loose
      list.measureInWindow((_lx, listY, _lw, listH) => {
        measureField((_x, fieldY, _w, fieldH) => {
          const offset = offsetToReveal({
            offset: scrollOffsetRef.current,
            fieldTop: fieldY,
            fieldBottom: fieldY + fieldH,
            visibleTop: listY + headerClearance,
            visibleBottom: listY + listH, // the composer's top; the list shrinks with the keyboard
          });
          if (offset !== null) listRef.current?.scrollToOffset({ offset, animated: true });
        });
      });
    });
  }

  function renderRequest(card: RequestCardState) {
    switch (card.kind) {
      case 'approval':
        return (
          <ApprovalCard
            card={card}
            actionable={isApprovalActionable(turn.requests, card.id)}
            onRespond={(choice) =>
              void responder().approve(card, choice).then((out) => {
                if (!out.ok) setError(out.message);
              })
            }
          />
        );
      case 'clarify':
        return <ClarifyCard card={card} responder={clarifyResponder} onInputFocus={revealField} />;
      case 'secure-entry':
        // The typed value goes straight to the response frame — never into state, a ref or an error.
        return (
          <SecureEntryCard
            card={card}
            provenance={card.method === 'secret' ? provenanceForCard(card, skills) : null}
            onSend={(v) => {
              const out = responder().value(card, v);
              if (!out.ok) setError(out.message);
            }}
            onSkip={() => {
              const out = responder().value(card, '');
              if (!out.ok) setError(out.message);
            }}
            onInputFocus={revealField}
          />
        );
      case 'vault-declined':
        return <VaultDeclinedNote />;
    }
  }

  const showGreeting = ready && items.length === 0 && turn.requests.length === 0 && !error;

  // Per-frame keyboard tracking (UI thread) — the composer rides the keyboard
  // instead of jumping when it appears. One continuous function: home-indicator
  // padding at rest, an 8pt gap above the keyboard once it's up.
  // Android (SDK 56) renders edge-to-edge; without the translucency flags
  // Reanimated reports keyboard heights offset by the system bar heights.
  // Both options are ignored on iOS.
  const keyboard = useAnimatedKeyboard({
    isStatusBarTranslucentAndroid: true,
    isNavigationBarTranslucentAndroid: true,
  });
  const containerStyle = useAnimatedStyle(() => ({
    paddingBottom: Math.max(insets.bottom, 10, keyboard.height.value + 8),
  }));

  return (
    <Animated.View style={[{ flex: 1, backgroundColor: colors.bg }, containerStyle]}>
      {showGreeting ? (
        <Animated.View
          entering={FadeIn.duration(350)}
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            padding: 32,
            gap: 18,
            // Center between the floating header and the composer, not the
            // full screen — matches where the Claude app parks its greeting.
            paddingTop: insets.top + 52 + 32,
          }}
        >
          <Image
            // Pre-rasterized at 3× from the lobehub HermesAgent.Text SVG —
            // expo-image's SVG coder mangles its evenodd paths.
            source={require('../../../assets/images/hermesagent-text.png')}
            accessibilityLabel="Hermes 智能体"
            contentFit="contain"
            tintColor={colors.text}
            // 52×24 lockup; size 56 matches HermesAgent.Text.
            style={{ height: 56, width: (56 * 52) / 24 }}
          />
          <Text style={{ fontFamily: serif, color: colors.text, fontSize: 30, textAlign: 'center' }}>
            {greetingForHour(new Date().getHours())}
          </Text>
          <Text style={{ color: colors.textFaint, fontSize: 14 }}>消息由你自己的网关处理。</Text>
        </Animated.View>
      ) : (
        <FlatList
          ref={listRef}
          data={reversedRows}
          inverted
          onScroll={(e) => {
            scrollOffsetRef.current = e.nativeEvent.contentOffset.y;
          }}
          scrollEventThrottle={16}
          // iOS 27 draws the scroll indicator mid-screen on long chats when UIKit adjusts the
          // indicator insets itself; this list has no bars to avoid, so opt out.
          automaticallyAdjustsScrollIndicatorInsets={false}
          keyExtractor={(r: Row) => (r.kind === 'item' ? r.item.key : `req:${r.card.id}`)}
          // 'interactive' is iOS-only; Android ignores it, so fall back to on-drag.
          keyboardDismissMode={process.env.EXPO_OS === 'ios' ? 'interactive' : 'on-drag'}
          keyboardShouldPersistTaps={cardFieldFocused ? 'handled' : 'never'}
          // Inverted list: contentContainer paddingBottom is the visual top —
          // clearance for the floating header buttons.
          contentContainerStyle={{
            paddingHorizontal: 16,
            paddingTop: 12,
            paddingBottom: headerClearance,
          }}
          renderItem={({ item: row }) => (
            // Entering-only fade (exiting animations orphan views — see
            // sidebar-host). Streaming updates keep the key, so no re-runs.
            <Animated.View entering={FadeIn.duration(180)}>
              {row.kind === 'request' ? (
                renderRequest(row.card)
              ) : row.item.subagent ? (
                <SubagentMonitorCard batch={row.item.subagent} />
              ) : row.item.todo ? (
                <TodoCard items={row.item.todo} />
              ) : (
                <MessageRow item={row.item} />
              )}
            </Animated.View>
          )}
          ListHeaderComponent={
            // Server-driven turn state is the authority: never show dots on an idle turn.
            thinking && busy ? (
              <Animated.View entering={FadeIn.duration(200)}>
                <ThinkingDots />
              </Animated.View>
            ) : null
          }
        />
      )}

      {/* Top fade: keeps the status bar and floating buttons readable while
          messages scroll beneath. CSS gradient — no native module needed. */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: insets.top + 78,
          // Fade to bg-at-zero-alpha (#RRGGBBAA), not `transparent` — black-alpha
          // interpolation leaves a gray smudge mid-fade.
          experimental_backgroundImage: `linear-gradient(to bottom, ${colors.bg} 0%, ${colors.bg} 35%, ${colors.bg}00 100%)`,
        }}
      />

      {/* Floating header — the native bar is hidden on chat routes. */}
      <View
        pointerEvents="box-none"
        style={{
          position: 'absolute',
          top: insets.top + 6,
          left: 14,
          right: 14,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <HeaderButton icon="line.3.horizontal" label="打开菜单" onPress={openSidebar} />
        <View style={{ flex: 1 }} />
        {items.length > 0 ? (
          <Animated.View entering={FadeIn.duration(200)}>
            <HeaderButton icon="square.and.arrow.up" label="导出会话" onPress={showExportSheet} />
          </Animated.View>
        ) : null}
        {id !== 'new' ? (
          <HeaderButton
            icon="square.and.pencil"
            label="新建会话"
            onPress={() => router.replace('/chat/new')}
          />
        ) : (
          <HeaderButton icon="gearshape" label="设置" onPress={() => router.push('/settings')} />
        )}
      </View>

      {reconnectNote ? (
        <Animated.Text
          entering={FadeIn.duration(200)}
          style={{ color: colors.textDim, fontSize: 13, paddingHorizontal: 16, paddingBottom: 6 }}
        >
          {reconnectNote}
        </Animated.Text>
      ) : null}
      {error || pending.error ? (
        <Animated.Text
          entering={FadeIn.duration(200)}
          selectable
          style={{ color: colors.danger, fontSize: 14, paddingHorizontal: 16, paddingBottom: 6 }}
        >
          {pending.error ?? error}
        </Animated.Text>
      ) : null}
      {pending.syncFailed ? (
        <Pressable accessibilityRole="button" accessibilityLabel="重试队列同步"
          onPress={() => outbox.retrySync()} style={{ flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingVertical: 8 }}>
          <Icon sf="arrow.clockwise" size={16} color={colors.accent} />
          <Text style={{ color: colors.text, fontSize: 14 }}>重试队列同步</Text>
        </Pressable>
      ) : null}
      {!ready && !error && !reconnectNote && !showGreeting && items.length === 0 ? (
        <View style={{ paddingBottom: 10 }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : null}
      {pending.steerNote ? <Text style={{ color: colors.textDim, fontSize: 12, paddingHorizontal: 16 }}>{pending.steerNote}</Text> : null}
      <MessageQueue entries={pending.queue} remoteText={pending.remoteQueued} disabled={pending.sending}
        paused={pending.paused} onContinue={() => outbox.continueQueue()}
        onCancel={(key) => void outbox.changeQueued(key, false)}
        onRestore={(key) => void outbox.changeQueued(key, true)}
        onRetry={(key) => outbox.retry(key)} />

      <Composer
        value={input}
        onChangeText={(text) => outbox.setText(text)}
        mode={composerMode(turn, input.trim().length > 0, Boolean(stagedImage) || pending.draft.files.length > 0)}
        onSend={send}
        onStop={() => void stop()}
        onSteer={() => void steer()}
        onQueue={() => outbox.enqueue()}
        disabled={!ready || !pending.hydrated}
        sending={pending.sending || pending.blocked}
        files={pending.draft.files}
        onRemoveFile={(key) => outbox.removeFile(key)}
        stagedImageUri={stagedImage?.uri ?? null}
        onAttachPress={() => router.push('/attach')}
        onRemoveImage={() => void outbox.removeImage()}
        modelName={modelName}
        onModelPress={() => router.push('/models?scope=session')}
      />
    </Animated.View>
  );
}
