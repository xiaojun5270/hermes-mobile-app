import type { ChatItem } from '../src/components/message-row';
import {
  appendAfterStream,
  appendStoppedMarker,
  cardsLosingAnchor,
  closeStreaming,
  createCardPinner,
  createItemsMirror,
  offsetToReveal,
  pinCards,
  reanchorAfterReplace,
  withCardAnchors,
  type CardAnchors,
} from '../src/lib/transcript-rows';
import { mergeRequestRows, type RequestCardState } from '../src/lib/turn-controller';

const item = (key: string): ChatItem => ({ key, role: 'assistant', text: key, complete: true });
const req = (id: string, anchorKey: string | null): RequestCardState => ({
  id, kind: 'approval', method: 'approval', params: {}, status: 'pending', legacy: false, receivedAt: 0, anchorKey,
});

// Plan A final review M5 (Preflight F3): React commits state after the JS turn, so an anchor read
// from a post-commit mirror put a card that arrived with its tool.start ABOVE that tool row.
describe('createItemsMirror', () => {
  test('a card arriving in the same JS turn as tool.start anchors below the tool row', () => {
    const committed: ChatItem[][] = []; // React's commit is deferred: nothing is applied yet
    const mirror = createItemsMirror<ChatItem>((next) => committed.push(next));
    mirror.update((prev) => [...prev, item('i0')]);
    mirror.update((prev) => [...prev, { key: 'i1', role: 'tool', text: 'terminal' }]);
    expect(mirror.anchorKey()).toBe('i1');
    const rows = mergeRequestRows(committed[committed.length - 1], [req('a', mirror.anchorKey())]);
    expect(rows.map((r) => (r.kind === 'item' ? r.item.key : r.card.id))).toEqual(['i0', 'i1', 'a']);
  });

  test('several updates in one JS turn compose in order; the last commit is the final list', () => {
    const committed: ChatItem[][] = [];
    const mirror = createItemsMirror<ChatItem>((next) => committed.push(next));
    mirror.update((prev) => [...prev, { key: 'i0', role: 'assistant', text: 'he', complete: false }]);
    mirror.update((prev) => [...prev.slice(0, -1), { ...prev[prev.length - 1], text: 'hello' }]);
    mirror.update((prev) => [...prev.slice(0, -1), { ...prev[prev.length - 1], complete: true }]);
    mirror.update((prev) => [...prev, item('i1')]);
    expect(committed).toHaveLength(4);
    expect(committed[3]).toEqual([{ key: 'i0', role: 'assistant', text: 'hello', complete: true }, item('i1')]);
  });

  test('a replace (history load) resets the anchor; an empty list anchors to null', () => {
    const mirror = createItemsMirror<ChatItem>(() => {});
    expect(mirror.anchorKey()).toBeNull();
    mirror.update(() => [item('h0'), item('h1')]);
    expect(mirror.anchorKey()).toBe('h1');
    mirror.update(() => []);
    expect(mirror.anchorKey()).toBeNull();
  });
});

const streaming = (key: string, text: string): ChatItem => ({ key, role: 'assistant', text, complete: false });
const keysOf = (rows: ReturnType<typeof mergeRequestRows<ChatItem>>) =>
  rows.map((r) => (r.kind === 'item' ? r.item.key : r.card.id));

describe('closeStreaming', () => {
  test('completes a trailing streaming segment and drops a whitespace-only one', () => {
    expect(closeStreaming([item('i0'), streaming('i1', 'then')])).toEqual([item('i0'), { ...streaming('i1', 'then'), complete: true }]);
    expect(closeStreaming([item('i0'), streaming('i1', ' \n')])).toEqual([item('i0')]);
  });

  test('leaves a list with no trailing streaming segment unchanged', () => {
    const list = [item('i0'), { key: 'i1', role: 'tool' as const, text: 'terminal' }];
    expect(closeStreaming(list)).toBe(list);
  });
});

// Sim S1 §3c / S2 §5 (B1): a steer while text streams left the pre-steer segment complete:false for
// good (stuck caret, plain text) because the Steered bubble was appended after it without closing it.
test('B1: a steered bubble appended mid-stream closes the streaming segment first', () => {
  const steered: ChatItem = { key: 'i2', role: 'user', text: 'stop at 20', complete: true, steered: true };
  const next = appendAfterStream([item('i0'), streaming('i1', '67 Florence')], steered);
  expect(next).toEqual([item('i0'), { ...streaming('i1', '67 Florence'), complete: true }, steered]);
  expect(next.filter((it) => it.role === 'assistant' && !it.complete)).toHaveLength(0);
});

// A history reload can already hold the stopped turn's marker (the gateway stores its closing row
// before it sends message.complete); the complete that then arrives live must not add a second one.
describe('appendStoppedMarker', () => {
  const marker = (key: string): ChatItem => ({ key, role: 'status', text: '已停止', marker: 'stopped' });

  test('appends the marker after the last row', () => {
    expect(appendStoppedMarker([item('i0')], marker('i1'))).toEqual([item('i0'), marker('i1')]);
    expect(appendStoppedMarker([], marker('i0'))).toEqual([marker('i0')]);
  });

  test('a transcript that already ends with the marker is returned as is', () => {
    const list = [item('i0'), marker('i1')];
    expect(appendStoppedMarker(list, marker('i2'))).toBe(list);
  });

  test('a later turn that is stopped too gets its own marker', () => {
    const list = [item('i0'), marker('i1'), { key: 'i2', role: 'user' as const, text: 'again', complete: true }];
    expect(appendStoppedMarker(list, marker('i3'))).toEqual([...list, marker('i3')]);
  });
});

// Task 11 m1: the router samples anchorKey() before onNewCard's finishAssistant() drops a trailing
// whitespace-only segment, so a card anchored to that dropped row vanished once settled.
describe('createItemsMirror anchor with a settle step', () => {
  test('a trailing whitespace-only streaming segment is not an anchor: the card stays under the row before it', () => {
    const committed: ChatItem[][] = [];
    const mirror = createItemsMirror<ChatItem>((next) => committed.push(next), closeStreaming);
    mirror.update(() => [item('i0'), { key: 'i1', role: 'tool', text: 'terminal' }, streaming('i2', '\n')]);
    const anchor = mirror.anchorKey(); // sampled by the router when the request arrives…
    mirror.update(closeStreaming); // …then onNewCard closes the segment
    expect(anchor).toBe('i1');
    const settled = req('a', anchor);
    settled.status = 'answered';
    expect(keysOf(mergeRequestRows(committed[committed.length - 1], [settled]))).toEqual(['i0', 'i1', 'a']);
  });

  test('a streaming segment with text is still the anchor (it is completed, not dropped)', () => {
    const mirror = createItemsMirror<ChatItem>(() => {}, closeStreaming);
    mirror.update(() => [item('i0'), streaming('i1', 'Running it now.')]);
    expect(mirror.anchorKey()).toBe('i1');
  });
});

// Sim S2 §1 (B2): scrolling the CARD row put a focused field of a card taller than the band above the
// keyboard off-screen (a 3-question batch is 1140 pt; the band is ~430 pt). The field itself is revealed.
describe('offsetToReveal (inverted list: a larger offset moves the content down)', () => {
  const band = { visibleTop: 126, visibleBottom: 556, margin: 12 };

  test('a field pushed above the band by the keyboard comes down to just under its top', () => {
    // S2: Q1's "Other…" field at py −424 after the keyboard rose.
    expect(offsetToReveal({ ...band, offset: 0, fieldTop: -424, fieldBottom: -384 })).toBe(562);
  });

  test('a field below the band goes up to just above the keyboard', () => {
    // S2 viewPosition 1: Q3's field at py 965.
    expect(offsetToReveal({ ...band, offset: 562, fieldTop: 965, fieldBottom: 1005 })).toBe(101);
  });

  test('a field already inside the band needs no scroll', () => {
    expect(offsetToReveal({ ...band, offset: 40, fieldTop: 259, fieldBottom: 299 })).toBeNull();
    expect(offsetToReveal({ ...band, offset: 40, fieldTop: 138, fieldBottom: 544 })).toBeNull(); // margins exactly met
  });

  test('a field taller than the band shows its top', () => {
    expect(offsetToReveal({ ...band, offset: 400, fieldTop: 400, fieldBottom: 900 })).toBe(138); // top lands at 138
  });

  test('never scrolls past the newest end (offset 0)', () => {
    expect(offsetToReveal({ ...band, offset: 20, fieldTop: 600, fieldBottom: 640 })).toBe(0);
  });
});

// Plan B final review I1: every history replace (each reconnect reloads) re-keys every row, so a card
// that was OPEN across it kept a vanished anchorKey. It showed at the tail only while open; once it
// settled mergeRequestRows dropped it, so no "Approved" / "Sent" / "Answered" row was left.
describe('reanchorAfterReplace + withCardAnchors (I1)', () => {
  const settle = (c: RequestCardState, status: RequestCardState['status']): RequestCardState => ({ ...c, status });
  const reloaded = [item('i7'), item('i8')]; // the same transcript, freshly keyed by the reload

  test('an open card across the re-key that then settles stays where it was drawn, with its settled state', () => {
    const open = req('a', 'i1'); // anchored to the pre-reload last row
    const anchors = reanchorAfterReplace([open], {}, reloaded);
    expect(anchors).toEqual({ a: 'i8' });
    const answered = settle(open, 'answered');
    const rows = mergeRequestRows(reloaded, withCardAnchors([answered], anchors));
    expect(keysOf(rows)).toEqual(['i7', 'i8', 'a']);
    const last = rows[rows.length - 1];
    expect(last.kind === 'request' && last.card.status).toBe('answered');
    // Without the re-anchor the settled card is gone (the I1 symptom).
    expect(keysOf(mergeRequestRows(reloaded, [answered]))).toEqual(['i7', 'i8']);
  });

  test('skipped and cancelled cards that were open across the reload stay visible too', () => {
    const anchors = reanchorAfterReplace([req('s', 'i1'), req('c', 'i1')], {}, reloaded);
    const rows = mergeRequestRows(reloaded, withCardAnchors([settle(req('s', 'i1'), 'skipped'), settle(req('c', 'i1'), 'cancelled')], anchors));
    expect(keysOf(rows)).toEqual(['i7', 'i8', 's', 'c']);
  });

  test('a card answering (in flight) at the reload counts as open', () => {
    expect(reanchorAfterReplace([settle(req('a', 'i1'), 'answering')], {}, reloaded)).toEqual({ a: 'i8' });
  });

  test('a card already settled before the reload is not redrawn (contract §8)', () => {
    const answered = settle(req('a', 'i1'), 'answered');
    const anchors = reanchorAfterReplace([answered], {}, reloaded);
    expect(anchors).toEqual({});
    expect(keysOf(mergeRequestRows(reloaded, withCardAnchors([answered], anchors)))).toEqual(['i7', 'i8']);
  });

  test('a second reload re-anchors a still-open card again and lets go of one that settled in between', () => {
    const first = reanchorAfterReplace([req('open', 'i1'), req('done', 'i1')], {}, reloaded);
    expect(first).toEqual({ open: 'i8', done: 'i8' });
    const again = [item('i20'), item('i21')];
    const second = reanchorAfterReplace([req('open', 'i1'), settle(req('done', 'i1'), 'answered')], first, again);
    expect(second).toEqual({ open: 'i21' });
  });

  test('m4: a card that arrived before any transcript row (anchorKey null) anchors to the loaded history and stays there once settled', () => {
    const early = req('a', null);
    const anchors = reanchorAfterReplace([early], {}, reloaded);
    expect(anchors).toEqual({ a: 'i8' });
    expect(keysOf(mergeRequestRows(reloaded, withCardAnchors([settle(early, 'answered')], anchors)))).toEqual(['i7', 'i8', 'a']);
  });

  test('an empty history leaves open cards as they are', () => {
    expect(reanchorAfterReplace([req('a', 'i1'), req('b', null)], {}, [])).toEqual({});
  });

  test('a card whose anchor survived keeps it; overrides of cards no longer in the store are dropped', () => {
    expect(reanchorAfterReplace([req('a', 'i7')], { gone: 'i3' }, reloaded)).toEqual({});
    expect(reanchorAfterReplace([req('a', 'i1')], { a: 'i7' }, reloaded)).toEqual({ a: 'i7' });
  });

  test('withCardAnchors: the same list back when no override applies; overridden cards get the new anchor', () => {
    const list = [req('a', 'i1'), req('b', 'i1')];
    expect(withCardAnchors(list, {})).toBe(list);
    expect(withCardAnchors(list, { x: 'i8' })).toBe(list);
    expect(withCardAnchors(list, { b: 'i8' }).map((c) => c.anchorKey)).toEqual(['i1', 'i8']);
  });
});

test('createItemsMirror().items() returns the latest list after update', () => {
  const mirror = createItemsMirror<ChatItem>(() => {});
  expect(mirror.items()).toEqual([]);
  mirror.update(() => [item('i0')]);
  mirror.update((prev) => [...prev, item('i1')]);
  expect(mirror.items().map((i) => i.key)).toEqual(['i0', 'i1']);
});

// D1 (QA 2026-09-29 item 6): after a mid-turn reconnect the reload pinned an open card under the
// reloaded history's last row, and the replay then appended the running clarify row BELOW the card.
describe('cardsLosingAnchor + pinCards (D1)', () => {
  const settle = (c: RequestCardState, status: RequestCardState['status']): RequestCardState => ({ ...c, status });
  const reloaded = [item('i7'), item('i8')];

  test('cardsLosingAnchor: open cards whose effective anchor is gone or null', () => {
    const cards = [req('dead', 'i1'), req('live', 'i1'), settle(req('settled', 'i1'), 'answered'), req('early', null), req('kept', 'i7')];
    expect(cardsLosingAnchor(cards, { live: 'i8' }, reloaded)).toEqual(['dead', 'early']);
  });

  test('pinCards pins to the last item and keeps a live override', () => {
    expect(pinCards([req('a', 'i1'), req('b', 'i1')], { b: 'i7' }, reloaded, ['a'])).toEqual({ a: 'i8', b: 'i7' });
  });

  test('pinCards drops a dead override that is not being pinned', () => {
    expect(pinCards([req('a', 'i1')], { a: 'i3' }, reloaded, [])).toEqual({});
  });

  test('pinCards drops an id whose card left the store, and never pins into an empty list', () => {
    expect(pinCards([], {}, reloaded, ['gone'])).toEqual({});
    expect(pinCards([req('a', 'i1')], {}, [], ['a'])).toEqual({});
  });

  test('pinCards walks the store, not the overrides: a live override of a card gone from the store drops (R9)', () => {
    expect(pinCards([], { gone: 'i7' }, reloaded, [])).toEqual({});
  });

  test('reanchorAfterReplace is the composition of the two', () => {
    const cards = [req('open', 'i1'), settle(req('done', 'i1'), 'answered'), req('kept', 'i1')];
    const anchors = { done: 'i2', kept: 'i7' };
    expect(reanchorAfterReplace(cards, anchors, reloaded)).toEqual(
      pinCards(cards, anchors, reloaded, cardsLosingAnchor(cards, anchors, reloaded)),
    );
    expect(reanchorAfterReplace(cards, anchors, reloaded)).toEqual({ open: 'i8', kept: 'i7' });
  });
});

describe('createCardPinner (D1: pin re-anchored cards at the end of the reconnect sequence)', () => {
  const settle = (c: RequestCardState, status: RequestCardState['status']): RequestCardState => ({ ...c, status });
  const user = (key: string): ChatItem => ({ key, role: 'user', text: key, complete: true });
  const toolRow = (key: string, name: string, running: boolean): ChatItem => ({
    key, role: 'tool', text: name, tool: { id: key, name, running },
  });
  const clarify = (anchorKey: string | null): RequestCardState => ({ ...req('card', anchorKey), kind: 'clarify', method: 'clarify.request' });
  const orderOf = (items: ChatItem[], cards: RequestCardState[], anchors: CardAnchors) =>
    keysOf(mergeRequestRows(items, withCardAnchors(cards, anchors)));
  const lastKey = (items: ChatItem[]) => items[items.length - 1]?.key ?? null;

  test('the D1 scenario: unpinned during the replay (drawn at the tail), pinned under the clarify row at the end', () => {
    const pinner = createCardPinner();
    pinner.sequenceStarted();
    const card = clarify('i1'); // pre-reconnect key, gone after the reload
    const reloaded = [user('i2'), item('i3')];
    let anchors: CardAnchors = pinner.onHistoryReplace([card], {}, reloaded);
    expect(anchors).toEqual({});
    const replayed = [...reloaded, toolRow('i4', 'clarify', true)];
    expect(orderOf(replayed, [card], anchors)).toEqual(['i2', 'i3', 'i4', 'card']); // tail, not above i4
    const pins = pinner.onSequenceEnd([card], replayed, lastKey(replayed));
    expect(pins).toEqual({ card: 'i4' });
    anchors = { ...anchors, ...pins };
    expect(orderOf(replayed, [card], anchors)).toEqual(['i2', 'i3', 'i4', 'card']);
    const later = [...replayed, item('i5')];
    expect(orderOf(later, [settle(card, 'answered')], anchors)).toEqual(['i2', 'i3', 'i4', 'card', 'i5']);
    expect(pinner.inSequence()).toBe(false);
  });

  test('a card that settles before the sequence ends is still pinned (not dropped)', () => {
    const pinner = createCardPinner();
    pinner.sequenceStarted();
    const card = clarify('i1');
    const reloaded = [user('i2'), item('i3')];
    pinner.onHistoryReplace([card], {}, reloaded);
    const replayed = [...reloaded, toolRow('i4', 'clarify', true)];
    const answered = settle(card, 'answered');
    const pins = pinner.onSequenceEnd([answered], replayed, lastKey(replayed));
    expect(orderOf(replayed, [answered], { ...pins })).toEqual(['i2', 'i3', 'i4', 'card']);
  });

  test('R1: settled in the window, then tool.complete and a continuation row: the card stays under its clarify row', () => {
    const pinner = createCardPinner();
    pinner.sequenceStarted();
    const card = clarify('i1');
    const reloaded = [user('i2'), item('i3')];
    pinner.onHistoryReplace([card], {}, reloaded);
    const items = [...reloaded, toolRow('i4', 'clarify', false), item('i5')];
    const answered = settle(card, 'answered');
    const pins = pinner.onSequenceEnd([answered], items, lastKey(items));
    expect(pins).toEqual({ card: 'i4' });
    expect(orderOf(items, [answered], { ...pins })).toEqual(['i2', 'i3', 'i4', 'card', 'i5']);
  });

  test('R1 rule 2: a non-clarify card goes under the last running tool row', () => {
    const pinner = createCardPinner();
    pinner.sequenceStarted();
    const card = req('card', 'i1'); // approval
    const reloaded = [user('i2')];
    pinner.onHistoryReplace([card], {}, reloaded);
    const items = [...reloaded, toolRow('i3', 'terminal', true), toolRow('i4', 'read_file', false)];
    expect(pinner.onSequenceEnd([card], items, lastKey(items))).toEqual({ card: 'i3' });
  });

  test('R1 rule 3: no requester row appended since the reload: the settled anchor (today\'s behaviour)', () => {
    const pinner = createCardPinner();
    pinner.sequenceStarted();
    const card = clarify('i1');
    // An OLD clarify row from an earlier turn is in the reloaded history: never a requester candidate.
    const reloaded = [user('i2'), toolRow('i3', 'clarify', false), item('i4')];
    pinner.onHistoryReplace([card], {}, reloaded);
    expect(pinner.onSequenceEnd([card], reloaded, 'i4')).toEqual({ card: 'i4' });
  });

  test('pins use the settled anchor passed in, not the raw last item (finding 7)', () => {
    const pinner = createCardPinner();
    pinner.sequenceStarted();
    const card = req('card', 'i1');
    const reloaded = [user('i2'), item('i3')];
    pinner.onHistoryReplace([card], {}, reloaded);
    const items = [...reloaded, streaming('i4', ' ')];
    expect(pinner.onSequenceEnd([card], items, 'i3')).toEqual({ card: 'i3' });
  });

  test('two reloads in one sequence union the record: a card that settled between them is still pinned', () => {
    const pinner = createCardPinner();
    pinner.sequenceStarted();
    const card = clarify('i1');
    pinner.onHistoryReplace([card], {}, [user('i2'), item('i3')]);
    const answered = settle(card, 'answered');
    const second = [user('i4'), item('i5'), toolRow('i6', 'clarify', false), item('i7')];
    expect(pinner.onHistoryReplace([answered], {}, second)).toEqual({}); // settled: not recorded again
    const pins = pinner.onSequenceEnd([answered], second, 'i7');
    expect(pins).toEqual({ card: 'i7' });
    expect(orderOf(second, [answered], { ...pins })).toContain('card');
  });

  test('a card first delivered during the sequence is recorded and pinned under its requester row (finding 5)', () => {
    const pinner = createCardPinner();
    pinner.sequenceStarted();
    const reloaded = [user('i2'), item('i3')];
    pinner.onHistoryReplace([], {}, reloaded);
    const card = clarify('i3'); // anchored to the reloaded last row, which is still live
    expect(pinner.inSequence()).toBe(true);
    pinner.onCardCreatedDuringSequence(card.id);
    const items = [...reloaded, toolRow('i4', 'clarify', true)];
    expect(pinner.onSequenceEnd([card], items, 'i4')).toEqual({ card: 'i4' });
  });

  test('a card created during the sequence with a live anchor and no requester row after it keeps its anchor', () => {
    const pinner = createCardPinner();
    pinner.sequenceStarted();
    const items = [user('i2'), toolRow('i3', 'terminal', true)];
    const card = req('card', 'i3');
    pinner.onCardCreatedDuringSequence(card.id);
    const later = [...items, item('i4')];
    expect(pinner.onSequenceEnd([card], later, 'i4')).toEqual({ card: 'i3' });
  });

  test('onSequenceEnd: null when nothing was recorded; the record is cleared after a pin', () => {
    const pinner = createCardPinner();
    pinner.sequenceStarted();
    expect(pinner.onSequenceEnd([], [item('i0')], 'i0')).toBeNull();
    pinner.sequenceStarted();
    pinner.onHistoryReplace([req('a', 'i1')], {}, [item('i2')]);
    expect(pinner.onSequenceEnd([req('a', 'i1')], [item('i2')], 'i2')).toEqual({ a: 'i2' });
    expect(pinner.onSequenceEnd([req('a', 'i1')], [item('i2')], 'i2')).toBeNull();
  });

  test('a recorded card that left the store, or an empty transcript, pins nothing', () => {
    const pinner = createCardPinner();
    pinner.sequenceStarted();
    pinner.onHistoryReplace([req('a', 'i1')], {}, []);
    expect(pinner.onSequenceEnd([req('a', 'i1')], [], null)).toEqual({});
    pinner.sequenceStarted();
    pinner.onHistoryReplace([req('b', 'i1')], {}, [item('i2')]);
    expect(pinner.onSequenceEnd([], [item('i2')], 'i2')).toEqual({});
  });

  test('onHistoryReplace keeps live overrides and drops dead or gone ones, pinning nothing yet', () => {
    const pinner = createCardPinner();
    pinner.sequenceStarted();
    const reloaded = [item('i7'), item('i8')];
    expect(pinner.onHistoryReplace([req('a', 'i1'), req('b', 'i1')], { a: 'i7', b: 'i3', gone: 'i8' }, reloaded)).toEqual({ a: 'i7' });
    expect(pinner.onSequenceEnd([req('a', 'i1'), req('b', 'i1')], reloaded, 'i8')).toEqual({ b: 'i8' });
  });
});
