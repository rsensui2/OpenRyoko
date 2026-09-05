import cron from 'node-cron';

export type CronScheduleField = 'schedule' | 'timezone' | 'until';

export interface CronScheduleValidationError {
  field: CronScheduleField;
  message: string;
}

export interface CronScheduleInput {
  schedule: unknown;
  timezone?: unknown;
  until?: unknown;
}

/** Validate with the same cron parser used by the scheduler plus the platform's
 * IANA timezone implementation. This is safe to call before any persistence. */
export function validateCronSchedule(input: CronScheduleInput): CronScheduleValidationError[] {
  const errors: CronScheduleValidationError[] = [];
  if (typeof input.schedule !== 'string' || !input.schedule.trim() || !cron.validate(input.schedule.trim())) {
    errors.push({ field: 'schedule', message: 'schedule must be a valid cron expression' });
  }
  if (input.timezone !== undefined) {
    if (typeof input.timezone !== 'string' || !input.timezone.trim()) {
      errors.push({ field: 'timezone', message: 'timezone must be a non-empty IANA timezone' });
    } else {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: input.timezone.trim() }).format(0);
      } catch {
        errors.push({ field: 'timezone', message: `timezone "${input.timezone}" is not a valid IANA timezone` });
      }
    }
  }
  if (input.until !== undefined) {
    const timestamp = typeof input.until === 'string' && input.until.trim() ? Date.parse(input.until) : Number.NaN;
    if (!Number.isFinite(timestamp)) {
      errors.push({ field: 'until', message: 'until must be a finite ISO-8601 timestamp' });
    }
  }
  return errors;
}
