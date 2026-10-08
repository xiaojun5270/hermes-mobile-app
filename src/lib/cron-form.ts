// src/lib/cron-form.ts — pure helpers for the cron create/edit form.
// Schedule strings are parsed SERVER-side (cron/jobs.py); the client only
// validates presence and shows the gateway-rendered display as the preview.
import { scheduleDisplay, type CronJob } from '../api/cron';
import { scheduleLabel, scheduleWire } from './zh-cn';

export interface CronFormValues {
  name: string;
  schedule: string;
  prompt: string;
  deliver: string;
}

export interface CronFormErrors {
  schedule?: string;
  prompt?: string;
}

/** Common natural-language schedules the gateway parser understands —
 * rendered as one-tap chips above the schedule field. */
export const SCHEDULE_PRESETS = [
  'every day at 9am',
  'every hour',
  'every monday at 9am',
  'every 30 minutes',
] as const;

/** Client-side validation: both schedule and prompt are required by the REST
 * create surface (everything else has server defaults). Empty result = valid. */
export function validateCronForm(values: Pick<CronFormValues, 'schedule' | 'prompt'>): CronFormErrors {
  const errors: CronFormErrors = {};
  if (!values.schedule.trim()) errors.schedule = '请填写运行计划，例如每天 9 点。';
  else {
    try {
      scheduleWire(values.schedule);
    } catch (error) {
      errors.schedule = (error as Error).message;
    }
  }
  if (!values.prompt.trim()) errors.prompt = '请填写任务内容。';
  return errors;
}

/** The text to prefill the schedule input with when editing: the server's
 * human display (re-parseable, e.g. "every day at 9am"); empty if missing. */
export function initialScheduleText(job: Pick<CronJob, 'schedule' | 'schedule_display'>): string {
  const display = scheduleDisplay(job);
  return display === '—' ? '' : display;
}

/** Live preview under the schedule input. While the text still matches the
 * saved schedule we can show the gateway-confirmed display; otherwise be
 * honest that parsing happens on save. */
export function schedulePreview(input: string, savedScheduleText: string): string {
  const t = input.trim();
  if (!t) return '例如每天 9 点、每 2 小时、周五 17:30';
  if (savedScheduleText && t === savedScheduleText.trim()) return `运行计划：${scheduleLabel(t)}`;
  return `“${scheduleLabel(t)}”，保存时由网关检查`;
}

/** Minimal PUT `updates` diff for an edit. Only changed fields are sent, so an
 * untouched schedule is never re-parsed (its raw form may not round-trip).
 * `enabled` is handled separately via the pause/resume endpoints. */
export function buildCronUpdates(
  job: Pick<CronJob, 'name' | 'prompt' | 'deliver'>,
  savedScheduleText: string,
  form: CronFormValues,
): Record<string, unknown> {
  const updates: Record<string, unknown> = {};
  const name = form.name.trim();
  if (name !== (job.name ?? '')) updates.name = name;
  const prompt = form.prompt.trim();
  if (prompt !== (job.prompt ?? '')) updates.prompt = prompt;
  const schedule = form.schedule.trim();
  if (schedule !== savedScheduleText.trim()) {
    const wire = scheduleWire(schedule);
    if (wire !== savedScheduleText.trim()) updates.schedule = wire;
  }
  if (form.deliver && form.deliver !== (job.deliver ?? 'local')) updates.deliver = form.deliver;
  return updates;
}
