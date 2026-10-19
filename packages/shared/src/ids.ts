import { randomUUID } from 'node:crypto';

const PREFIXES = {
  org: 'org',
  user: 'usr',
  membership: 'mem',
  client: 'cli',
  project: 'prj',
  request: 'req',
  task: 'tsk',
  workflowRun: 'run',
  approval: 'apr',
  integration: 'int',
  credential: 'cred',
  audit: 'aud',
  checklist: 'chk',
  comment: 'cmt',
  taskLink: 'lnk',
  timeEntry: 'tim',
  taskReview: 'rev',
  dependency: 'dep',
  outbound: 'ob',
  outboundEvent: 'obevt',
  lead: 'lead',
  oauth: 'oauth',
} as const;

export type IdKind = keyof typeof PREFIXES;

/**
 * Prefixed, sortable-ish ids: `<prefix>_<base32 time><random>`.
 *
 * Prefixes make ids self-describing in logs and URLs ("tsk_..." is a task), and the time
 * prefix keeps them roughly ordered, which makes debugging without a query window possible.
 */
export function newId(kind: IdKind): string {
  const time = Date.now().toString(32).padStart(9, '0');
  const rand = randomUUID().replace(/-/g, '').slice(0, 10).toLowerCase();
  return `${PREFIXES[kind]}_${time}${rand}`;
}

export function idKindOf(id: string): IdKind | null {
  const prefix = id.split('_')[0];
  const match = (Object.keys(PREFIXES) as IdKind[]).find((k) => PREFIXES[k] === prefix);
  return match ?? null;
}

/** Stable idempotency key for inbound provider events. */
export function idempotencyKey(provider: string, externalId: string): string {
  return `${provider}:${externalId}`;
}
