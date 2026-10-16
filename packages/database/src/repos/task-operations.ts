import type { Queryable } from '../client.js';
import {
  mapChecklistItem,
  mapTaskClientReview,
  mapTaskComment,
  mapTaskDependency,
  mapTaskLink,
  mapTaskTimeEntry,
} from '../mappers.js';
import type {
  TaskChecklistItem,
  TaskClientReview,
  TaskComment,
  TaskDependency,
  TaskLink,
  TaskLinkKind,
  TaskTimeEntry,
} from '@flowpilot/domain';

type Row = Record<string, unknown>;

export class TaskOperationsRepo {
  constructor(private readonly db: Queryable) {}

  async listChecklist(orgId: string, taskId: string): Promise<TaskChecklistItem[]> {
    const rows = await this.db.query<Row>(
      'select * from task_checklist_items where org_id = $1 and task_id = $2 order by sort_order, created_at',
      [orgId, taskId],
    );
    return rows.map(mapChecklistItem);
  }

  async createChecklist(input: { id: string; orgId: string; taskId: string; title: string; createdBy: string }): Promise<TaskChecklistItem> {
    const row = await this.db.one<Row>(
      `insert into task_checklist_items (id, org_id, task_id, title, created_by, sort_order)
       values ($1,$2,$3,$4,$5,(select coalesce(max(sort_order),0)+1 from task_checklist_items where org_id=$2 and task_id=$3)) returning *`,
      [input.id, input.orgId, input.taskId, input.title, input.createdBy],
    );
    return mapChecklistItem(row!);
  }

  async updateChecklist(orgId: string, taskId: string, itemId: string, patch: { title?: string; isComplete?: boolean }): Promise<TaskChecklistItem | null> {
    const sets: string[] = [];
    const params: unknown[] = [orgId, taskId, itemId];
    const push = (column: string, value: unknown) => { params.push(value); sets.push(`${column} = $${params.length}`); };
    if (patch.title !== undefined) push('title', patch.title);
    if (patch.isComplete !== undefined) {
      push('is_complete', patch.isComplete);
      params.push(patch.isComplete ? new Date().toISOString() : null);
      sets.push(`completed_at = $${params.length}`);
    }
    if (!sets.length) return null;
    const row = await this.db.one<Row>(
      `update task_checklist_items set ${sets.join(', ')} where org_id=$1 and task_id=$2 and id=$3 returning *`,
      params,
    );
    return row ? mapChecklistItem(row) : null;
  }

  async addComment(input: { id: string; orgId: string; taskId: string; authorId: string; authorLabel: string; body: string }): Promise<TaskComment> {
    const row = await this.db.one<Row>(
      'insert into task_comments (id,org_id,task_id,author_id,author_label,body) values ($1,$2,$3,$4,$5,$6) returning *',
      [input.id, input.orgId, input.taskId, input.authorId, input.authorLabel, input.body],
    );
    return mapTaskComment(row!);
  }

  async listComments(orgId: string, taskId: string): Promise<TaskComment[]> {
    const rows = await this.db.query<Row>(
      'select * from task_comments where org_id=$1 and task_id=$2 order by created_at desc limit 100',
      [orgId, taskId],
    );
    return rows.map(mapTaskComment);
  }

  async addLink(input: { id: string; orgId: string; taskId: string; label: string; url: string; kind: TaskLinkKind; addedBy: string }): Promise<TaskLink> {
    const row = await this.db.one<Row>(
      'insert into task_links (id,org_id,task_id,label,url,kind,added_by) values ($1,$2,$3,$4,$5,$6,$7) returning *',
      [input.id, input.orgId, input.taskId, input.label, input.url, input.kind, input.addedBy],
    );
    return mapTaskLink(row!);
  }

  async listLinks(orgId: string, taskId: string): Promise<TaskLink[]> {
    const rows = await this.db.query<Row>(
      'select * from task_links where org_id=$1 and task_id=$2 order by created_at desc', [orgId, taskId]);
    return rows.map(mapTaskLink);
  }

  async addTimeEntry(input: { id: string; orgId: string; taskId: string; userId: string; description?: string; hours: number; loggedOn?: string }): Promise<TaskTimeEntry> {
    const row = await this.db.one<Row>(
      `insert into task_time_entries (id,org_id,task_id,user_id,description,hours,logged_on)
       values ($1,$2,$3,$4,$5,$6,coalesce($7::date,current_date))
       returning task_time_entries.*, (select full_name from users where id=task_time_entries.user_id) as user_label`,
      [input.id, input.orgId, input.taskId, input.userId, input.description ?? null, input.hours, input.loggedOn ?? null],
    );
    return mapTaskTimeEntry(row!);
  }

  async listTimeEntries(orgId: string, taskId: string): Promise<TaskTimeEntry[]> {
    const rows = await this.db.query<Row>(
      `select e.*, u.full_name as user_label from task_time_entries e join users u on u.id=e.user_id
        where e.org_id=$1 and e.task_id=$2 order by e.logged_on desc, e.created_at desc`,
      [orgId, taskId],
    );
    return rows.map(mapTaskTimeEntry);
  }

  async listDependencies(orgId: string, taskId: string): Promise<TaskDependency[]> {
    const rows = await this.db.query<Row>(
      `select d.*, p.title as depends_on_title, p.status as depends_on_status
         from task_dependencies d join tasks p on p.id=d.depends_on_task_id and p.org_id=d.org_id
        where d.org_id=$1 and d.task_id=$2 order by d.created_at`,
      [orgId, taskId],
    );
    return rows.map(mapTaskDependency);
  }

  async listAllDependencies(orgId: string): Promise<Array<{ taskId: string; dependsOnTaskId: string }>> {
    const rows = await this.db.query<Row>('select task_id, depends_on_task_id from task_dependencies where org_id=$1', [orgId]);
    return rows.map((row) => ({ taskId: String(row['task_id']), dependsOnTaskId: String(row['depends_on_task_id']) }));
  }

  async addDependency(input: { id: string; orgId: string; taskId: string; dependsOnTaskId: string }): Promise<void> {
    await this.db.query(
      'insert into task_dependencies (id,org_id,task_id,depends_on_task_id) values ($1,$2,$3,$4)',
      [input.id, input.orgId, input.taskId, input.dependsOnTaskId],
    );
  }

  async removeDependency(orgId: string, taskId: string, dependsOnTaskId: string): Promise<boolean> {
    const rows = await this.db.query(
      'delete from task_dependencies where org_id=$1 and task_id=$2 and depends_on_task_id=$3 returning id',
      [orgId, taskId, dependsOnTaskId],
    );
    return rows.length > 0;
  }

  async getLatestReview(orgId: string, taskId: string): Promise<TaskClientReview | null> {
    const row = await this.db.one<Row>(
      'select * from task_client_reviews where org_id=$1 and task_id=$2 order by created_at desc limit 1',
      [orgId, taskId],
    );
    return row ? mapTaskClientReview(row) : null;
  }

  async createReview(input: { id: string; orgId: string; taskId: string; tokenHash: string; requestedBy: string; expiresAt: string }): Promise<TaskClientReview> {
    const row = await this.db.one<Row>(
      `insert into task_client_reviews (id,org_id,task_id,token_hash,status,requested_by,expires_at)
       values ($1,$2,$3,$4,'pending',$5,$6) returning *`,
      [input.id, input.orgId, input.taskId, input.tokenHash, input.requestedBy, input.expiresAt],
    );
    return mapTaskClientReview(row!);
  }

  async expireReview(orgId: string, reviewId: string): Promise<void> {
    await this.db.query(
      "update task_client_reviews set status='expired' where org_id=$1 and id=$2 and status='pending' and expires_at <= now()",
      [orgId, reviewId],
    );
  }

  async findReviewPortal(tokenHash: string): Promise<Row | null> {
    return this.db.one<Row>(
      `select r.*, t.title as task_title, t.description as task_description, p.name as project_name, c.name as client_name
         from task_client_reviews r join tasks t on t.id=r.task_id and t.org_id=r.org_id
         join projects p on p.id=t.project_id and p.org_id=t.org_id
         join clients c on c.id=p.client_id and c.org_id=p.org_id
        where r.token_hash=$1 and r.status='pending' and r.expires_at > now()`,
      [tokenHash],
    );
  }

  async respondReview(tokenHash: string, input: { status: 'approved' | 'changes_requested'; reviewerName: string; reviewerEmail?: string; note?: string }): Promise<TaskClientReview | null> {
    const row = await this.db.one<Row>(
      `update task_client_reviews set status=$2, reviewer_name=$3, reviewer_email=$4, note=$5, responded_at=now()
        where token_hash=$1 and status='pending' and expires_at > now() returning *`,
      [tokenHash, input.status, input.reviewerName, input.reviewerEmail ?? null, input.note ?? null],
    );
    return row ? mapTaskClientReview(row) : null;
  }
}
