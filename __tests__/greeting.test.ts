import { greetingForHour } from '../src/lib/greeting';

describe('greetingForHour', () => {
  it('morning hours', () => {
    expect(greetingForHour(5)).toBe('早上好');
    expect(greetingForHour(11)).toBe('早上好');
  });

  it('afternoon hours', () => {
    expect(greetingForHour(12)).toBe('下午好');
    expect(greetingForHour(17)).toBe('下午好');
  });

  it('evening hours', () => {
    expect(greetingForHour(18)).toBe('晚上好');
    expect(greetingForHour(22)).toBe('晚上好');
  });

  it('late night wraps past midnight', () => {
    expect(greetingForHour(23)).toBe('夜深了');
    expect(greetingForHour(0)).toBe('夜深了');
    expect(greetingForHour(4)).toBe('夜深了');
  });
});
