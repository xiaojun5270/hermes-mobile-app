import type { SearchResult } from '@/api/search';
import { searchView } from '../sidebar-search';

const hit = (session_id: string): SearchResult => ({ snippet: '', role: null, session_id });
const results = [hit('a'), hit('b')];

test('an empty or blank query shows no server hits and no spinner', () => {
  expect(searchView('', { q: 'abc', results }, true)).toEqual({ pending: false, results: null });
  expect(searchView('   ', { q: 'abc', results }, true)).toEqual({ pending: false, results: null });
});

test('server search unavailable (non-default profile) never pends and never shows hits', () => {
  expect(searchView('abc', { q: 'abc', results }, false)).toEqual({ pending: false, results: null });
  expect(searchView('abc', null, false)).toEqual({ pending: false, results: null });
});

test('no answer yet for a live query pends', () => {
  expect(searchView('abc', null, true)).toEqual({ pending: true, results: null });
});

test('hits for a different query are never shown; the live query pends', () => {
  expect(searchView('abcd', { q: 'abc', results }, true)).toEqual({ pending: true, results: null });
});

test('hits for the live query are shown', () => {
  expect(searchView('abc', { q: 'abc', results }, true)).toEqual({ pending: false, results });
});

test('an empty answer is still an answer (没有匹配结果), not a pending search', () => {
  expect(searchView('abc', { q: 'abc', results: [] }, true)).toEqual({ pending: false, results: [] });
});

test('a failed request for the live query stops pending and falls back to the client filter', () => {
  expect(searchView('abc', { q: 'abc', results: null }, true)).toEqual({ pending: false, results: null });
});

test('the query is matched trimmed', () => {
  expect(searchView('  abc  ', { q: 'abc', results }, true)).toEqual({ pending: false, results });
});

test('retyping an earlier query whose hits are still held shows them immediately', () => {
  const held = { q: 'abc', results };
  expect(searchView('abcd', held, true).pending).toBe(true); // typed on
  expect(searchView('abc', held, true)).toEqual({ pending: false, results }); // backspaced
});
