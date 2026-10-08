/** Display labels only. The wire schedules remain the gateway's supported parser inputs. */
export const SCHEDULE_LABELS: Record<string, string> = {
  'every day at 9am': '每天 9 点',
  'every hour': '每小时',
  'every monday at 9am': '每周一 9 点',
  'every 30 minutes': '每 30 分钟',
};
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const ZH_WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const UNSUPPORTED_SCHEDULE = '暂不支持此中文计划，请使用示例格式或英文计划。';

export function scheduleLabel(wire: string): string {
  const text = wire.trim();
  if (SCHEDULE_LABELS[text]) return SCHEDULE_LABELS[text];
  const interval = /^every ([1-9]\d*) (hours?|minutes?)$/.exec(text);
  if (interval) return `每 ${interval[1]} ${interval[2].startsWith('hour') ? '小时' : '分钟'}`;
  const weekly = /^every (sunday|monday|tuesday|wednesday|thursday|friday|saturday) at (\d{1,2}):(\d{2})(am|pm)?$/.exec(text);
  if (weekly) {
    let hour = Number(weekly[2]);
    const minute = Number(weekly[3]);
    if (minute > 59 || (weekly[4] ? hour < 1 || hour > 12 : hour > 23)) return text;
    if (weekly[4]) hour = hour % 12 + (weekly[4] === 'pm' ? 12 : 0);
    return `周${ZH_WEEKDAYS[WEEKDAYS.indexOf(weekly[1])]} ${String(hour).padStart(2, '0')}:${weekly[3]}`;
  }
  return text;
}
export function scheduleWire(label: string): string {
  const text = label.trim();
  const preset = Object.keys(SCHEDULE_LABELS).find((wire) => SCHEDULE_LABELS[wire] === text);
  if (preset) return preset;
  const interval = /^每\s*([1-9]\d*)\s*(小时|分钟)$/.exec(text);
  if (interval) return `every ${interval[1]} ${interval[2] === '小时' ? 'hours' : 'minutes'}`;
  const weekly = /^周([一二三四五六日天])\s*([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (weekly) {
    const day = weekly[1] === '天' ? '日' : weekly[1];
    const hour = Number(weekly[2]);
    return `every ${WEEKDAYS[ZH_WEEKDAYS.indexOf(day)]} at ${hour % 12 || 12}:${weekly[3]}${hour >= 12 ? 'pm' : 'am'}`;
  }
  if (/[\u3400-\u9fff]/.test(text)) throw new Error(UNSUPPORTED_SCHEDULE);
  return text;
}
