const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** Compact relative timestamp in the style of messaging apps. */
export function timeAgo(unixSeconds: number, now: Date = new Date()): string {
  const then = new Date(unixSeconds * 1000);
  const diffSec = Math.max(0, (now.getTime() - then.getTime()) / 1000);
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
  if (diffSec < 86400 && then.getDate() === now.getDate()) return `${Math.floor(diffSec / 3600)} 小时前`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (then.toDateString() === yesterday.toDateString()) return '昨天';
  if (diffSec < 7 * 86400) return WEEKDAYS[then.getDay()];

  const md = `${then.getMonth() + 1}月${then.getDate()}日`;
  return then.getFullYear() === now.getFullYear() ? md : `${then.getFullYear()}年${md}`;
}

/** Compact relative timestamp for next-run displays; distinguishes overdue from imminent. */
export function timeUntil(unixSeconds: number, now: Date = new Date()): string {
  const diffSec = (unixSeconds * 1000 - now.getTime()) / 1000;
  if (diffSec <= 0) return '已到期';
  if (diffSec < 60) return '即将';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟后`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时后`;
  if (diffSec < 30 * 86400) return `${Math.floor(diffSec / 86400)} 天后`;

  const then = new Date(unixSeconds * 1000);
  const md = `${then.getMonth() + 1}月${then.getDate()}日`;
  return then.getFullYear() === now.getFullYear() ? md : `${then.getFullYear()}年${md}`;
}

/** Parse an ISO-8601 timestamp (cron job records) to unix seconds; null when absent or invalid. */
export function isoToUnix(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}
