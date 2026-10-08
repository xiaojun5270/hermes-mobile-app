// __tests__/cronForm.test.ts — pure cron create/edit form helpers.
import {
  SCHEDULE_PRESETS,
  buildCronUpdates,
  initialScheduleText,
  schedulePreview,
  validateCronForm,
} from '../src/lib/cron-form';
import { scheduleLabel, scheduleWire } from '../src/lib/zh-cn';

describe('validateCronForm', () => {
  it('passes when both required fields are present', () => {
    expect(validateCronForm({ schedule: 'every day at 9am', prompt: 'do the thing' })).toEqual({});
  });

  it('requires a non-blank schedule and prompt (whitespace is not enough)', () => {
    const errors = validateCronForm({ schedule: '   ', prompt: '' });
    expect(errors.schedule).toMatch(/请填写运行计划/);
    expect(errors.prompt).toMatch(/请填写任务内容/);
  });

  it('does not require a name (server defaults it)', () => {
    // name intentionally absent from the validated shape
    expect(Object.keys(validateCronForm({ schedule: 's', prompt: 'p' }))).toEqual([]);
  });
});

describe('initial运行计划Text', () => {
  it('prefers the top-level display mirror', () => {
    expect(
      initialScheduleText({ schedule_display: 'every day at 9am', schedule: { kind: 'cron', display: 'old' } }),
    ).toBe('every day at 9am');
  });

  it('falls back to schedule.display and never returns the dash placeholder', () => {
    expect(initialScheduleText({ schedule_display: null, schedule: { kind: 'interval', display: 'every 2h' } })).toBe(
      'every 2h',
    );
    expect(initialScheduleText({ schedule_display: null, schedule: null })).toBe('');
  });
});

describe('schedulePreview', () => {
  it('shows examples while empty', () => {
    expect(schedulePreview('', '')).toMatch(/例如/);
    expect(schedulePreview('   ', 'every day at 9am')).toMatch(/例如/);
  });

  it('confirms a schedule that still matches the gateway-saved one', () => {
    expect(schedulePreview('every day at 9am', 'every day at 9am')).toBe('运行计划：每天 9 点');
    expect(schedulePreview('  every day at 9am  ', 'every day at 9am')).toBe('运行计划：每天 9 点');
  });

  it('marks edited / unsaved schedules as pending gateway parsing', () => {
    expect(schedulePreview('every 5 minutes', 'every day at 9am')).toContain('每 5 分钟');
    expect(schedulePreview('every 5 minutes', 'every day at 9am')).toMatch(/网关/);
    expect(schedulePreview('every 5 minutes', '')).toMatch(/网关/); // create mode
  });
});

describe('Chinese schedule boundary', () => {
  it.each([
    [' 每天 9 点 ', 'every day at 9am', '每天 9 点'],
    ['每2小时', 'every 2 hours', '每 2 小时'],
    [' 每 2 小时 ', 'every 2 hours', '每 2 小时'],
    ['周五17:30', 'every friday at 5:30pm', '周五 17:30'],
    [' 周五 17:30 ', 'every friday at 5:30pm', '周五 17:30'],
    ['周日0:05', 'every sunday at 12:05am', '周日 00:05'],
    ['每30分钟', 'every 30 minutes', '每 30 分钟'],
  ])('converts only a supported schedule: %s', (input, wire, label) => {
    expect(scheduleWire(input)).toBe(wire);
    expect(scheduleLabel(wire)).toBe(label);
    expect(scheduleWire(scheduleLabel(wire))).toBe(wire);
    expect(validateCronForm({ schedule: input, prompt: 'keep user/model/OAuth 原话' })).toEqual({});
  });

  it.each(['每0小时', '周五25:30', '周五17:60', '下雨时运行', '每两小时'])('blocks unsupported Chinese before submit: %s', (schedule) => {
    expect(validateCronForm({ schedule, prompt: 'do not translate this' }).schedule).toMatch(/暂不支持/);
    expect(() => scheduleWire(schedule)).toThrow(/暂不支持/);
    expect(() => buildCronUpdates({ name: '', prompt: '', deliver: 'local' }, '', {
      name: '', schedule, prompt: 'do not translate this', deliver: 'local',
    })).toThrow(/暂不支持/);
  });

  it('preserves English parser inputs and user task content', () => {
    expect(scheduleWire('  0 17 * * 5  ')).toBe('0 17 * * 5');
    expect(scheduleWire(' every blarg ')).toBe('every blarg');
    expect(buildCronUpdates({ name: '', prompt: '', deliver: 'local' }, '', {
      name: '', schedule: '每2小时', prompt: '每2小时 user/model/OAuth Recommended', deliver: 'local',
    })).toEqual({ schedule: 'every 2 hours', prompt: '每2小时 user/model/OAuth Recommended' });
  });

  it('does not re-send an unchanged schedule when shown in Chinese', () => {
    expect(buildCronUpdates({ name: '', prompt: 'p', deliver: 'local' }, 'every 2 hours', {
      name: '', schedule: '每2小时', prompt: 'p', deliver: 'local',
    })).toEqual({});
  });
});

describe('buildCronUpdates', () => {
  const job = { name: 'Digest', prompt: 'summarize my day', deliver: 'local' };

  it('returns an empty diff when nothing changed (untouched schedule is never re-sent)', () => {
    expect(
      buildCronUpdates(job, 'every day at 9am', {
        name: 'Digest',
        schedule: ' every day at 9am ',
        prompt: 'summarize my day',
        deliver: 'local',
      }),
    ).toEqual({});
  });

  it('includes only the fields that changed, trimmed', () => {
    expect(
      buildCronUpdates(job, 'every day at 9am', {
        name: '  Evening digest ',
        schedule: 'every day at 9pm',
        prompt: 'summarize my day',
        deliver: 'telegram',
      }),
    ).toEqual({ name: 'Evening digest', schedule: 'every day at 9pm', deliver: 'telegram' });
  });

  it('treats null job fields as empty / local defaults', () => {
    expect(
      buildCronUpdates({ name: '', prompt: null, deliver: null }, '', {
        name: '',
        schedule: 'every hour',
        prompt: 'new prompt',
        deliver: 'local',
      }),
    ).toEqual({ schedule: 'every hour', prompt: 'new prompt' });
  });

  it('never includes immutable or unrelated fields', () => {
    const updates = buildCronUpdates(job, 'x', {
      name: 'Digest',
      schedule: 'x',
      prompt: 'summarize my day',
      deliver: 'local',
    });
    expect(updates).not.toHaveProperty('id');
    expect(updates).not.toHaveProperty('enabled'); // pause/resume endpoints own this
  });
});

describe('SCHEDULE_PRESETS', () => {
  it('offers 3-4 distinct natural-language presets', () => {
    expect(SCHEDULE_PRESETS.length).toBeGreaterThanOrEqual(3);
    expect(SCHEDULE_PRESETS.length).toBeLessThanOrEqual(4);
    expect(new Set(SCHEDULE_PRESETS).size).toBe(SCHEDULE_PRESETS.length);
  });
});
