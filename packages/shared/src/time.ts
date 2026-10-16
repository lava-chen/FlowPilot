/** Small date helpers so date logic is testable and never depends on the machine timezone. */

export function nowIso(): string {
  return new Date().toISOString();
}

export function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function addDays(from: Date, days: number): Date {
  const next = new Date(from.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/** "in 3 days" / "2 days overdue" — used in task cards and audit lines. */
export function relativeDays(from: Date, to: Date): string {
  const diffDays = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  if (diffDays === -1) return 'yesterday';
  if (diffDays > 0) return `in ${diffDays} days`;
  return `${Math.abs(diffDays)} days overdue`;
}

export function isPast(date: Date, reference: Date = new Date()): boolean {
  return date.getTime() < reference.getTime();
}
