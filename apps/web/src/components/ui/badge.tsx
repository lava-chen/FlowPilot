import { cva, type VariantProps } from 'class-variance-authority';
import type { Priority, RequestStatus, TaskStatus, WorkflowRunStatus } from '@flowpilot/domain';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap',
  {
    variants: {
      tone: {
        neutral: 'border-slate-200 bg-slate-50 text-slate-600',
        accent: 'border-indigo-200 bg-indigo-50 text-indigo-700',
        success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
        warning: 'border-amber-200 bg-amber-50 text-amber-700',
        danger: 'border-red-200 bg-red-50 text-red-700',
        info: 'border-sky-200 bg-sky-50 text-sky-700',
        dark: 'border-slate-700 bg-slate-800 text-slate-200',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({
  className,
  tone,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

const TASK_STATUS_META: Record<TaskStatus, { label: string; tone: NonNullable<VariantProps<typeof badgeVariants>['tone']> }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  pending_approval: { label: 'Pending approval', tone: 'warning' },
  ready: { label: 'Ready', tone: 'info' },
  in_progress: { label: 'In progress', tone: 'accent' },
  in_review: { label: 'In review', tone: 'accent' },
  completed: { label: 'Completed', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

const REQUEST_STATUS_META: Record<RequestStatus, { label: string; tone: NonNullable<VariantProps<typeof badgeVariants>['tone']> }> = {
  new: { label: 'New', tone: 'accent' },
  analyzed: { label: 'Analyzed', tone: 'info' },
  drafted: { label: 'Drafted', tone: 'warning' },
  approved: { label: 'Approved', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'danger' },
  failed: { label: 'Failed', tone: 'danger' },
};

const PRIORITY_META: Record<Priority, { label: string; tone: NonNullable<VariantProps<typeof badgeVariants>['tone']> }> = {
  low: { label: 'Low', tone: 'neutral' },
  normal: { label: 'Normal', tone: 'neutral' },
  high: { label: 'High', tone: 'warning' },
  urgent: { label: 'Urgent', tone: 'danger' },
};

const RUN_STATUS_META: Record<WorkflowRunStatus, { label: string; tone: NonNullable<VariantProps<typeof badgeVariants>['tone']> }> = {
  running: { label: 'Running', tone: 'accent' },
  waiting_approval: { label: 'Waiting approval', tone: 'warning' },
  succeeded: { label: 'Succeeded', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

export function TaskStatusBadge({ status, className }: { status: TaskStatus; className?: string }) {
  const meta = TASK_STATUS_META[status];
  return (
    <Badge tone={meta.tone} className={className}>
      {meta.label}
    </Badge>
  );
}

export function RequestStatusBadge({ status, className }: { status: RequestStatus; className?: string }) {
  const meta = REQUEST_STATUS_META[status];
  return (
    <Badge tone={meta.tone} className={className}>
      {meta.label}
    </Badge>
  );
}

export function PriorityBadge({ priority, className }: { priority: Priority; className?: string }) {
  const meta = PRIORITY_META[priority];
  return (
    <Badge tone={meta.tone} className={className}>
      {meta.label}
    </Badge>
  );
}

export function RunStatusBadge({ status, className }: { status: WorkflowRunStatus; className?: string }) {
  const meta = RUN_STATUS_META[status];
  return (
    <Badge tone={meta.tone} className={className}>
      {meta.label}
    </Badge>
  );
}

export const statusLabel = (status: TaskStatus): string => TASK_STATUS_META[status].label;
export const requestStatusLabel = (status: RequestStatus): string => REQUEST_STATUS_META[status].label;

export { badgeVariants };
