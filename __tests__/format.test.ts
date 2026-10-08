// __tests__/format.test.ts
import { isoToUnix, timeAgo, timeUntil } from '../src/lib/format';

const NOW = new Date('2026-06-11T12:00:00Z');
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

describe('timeUntil', () => {
  it('distinguishes due/overdue from imminent future times', () => {
    expect(timeUntil(at('2026-06-11T11:00:00Z'), NOW)).toBe('已到期');
    expect(timeUntil(at('2026-06-11T12:00:00Z'), NOW)).toBe('已到期');
    expect(timeUntil(at('2026-06-11T12:00:30Z'), NOW)).toBe('即将');
  });

  it('renders minutes, hours and days', () => {
    expect(timeUntil(at('2026-06-11T12:05:00Z'), NOW)).toBe('5 分钟后');
    expect(timeUntil(at('2026-06-11T15:30:00Z'), NOW)).toBe('3 小时后');
    expect(timeUntil(at('2026-06-13T18:00:00Z'), NOW)).toBe('2 天后');
  });

  it('falls back to a date beyond 30 days', () => {
    const far = timeUntil(at('2026-08-15T12:00:00Z'), NOW);
    expect(far).toMatch(/^8月1[45]日$/); // local-tz tolerant
    expect(timeUntil(at('2027-02-01T12:00:00Z'), NOW)).toMatch(/^2027年/);
  });
});

describe('isoToUnix', () => {
  it('parses ISO-8601 with offset (cron job record format)', () => {
    expect(isoToUnix('2026-06-11T09:00:01+00:00')).toBe(at('2026-06-11T09:00:01Z'));
  });

  it('returns null for null/undefined/empty/garbage', () => {
    expect(isoToUnix(null)).toBeNull();
    expect(isoToUnix(undefined)).toBeNull();
    expect(isoToUnix('')).toBeNull();
    expect(isoToUnix('not-a-date')).toBeNull();
  });

  it('round-trips into timeAgo', () => {
    const unix = isoToUnix('2026-06-11T11:30:00Z');
    expect(unix).not.toBeNull();
    expect(timeAgo(unix!, NOW)).toBe('30 分钟前'); // tz-independent (sub-hour bucket)
  });
});
