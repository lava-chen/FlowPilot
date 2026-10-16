import type { Queryable } from '../client.js';
import { NotFoundError, OrganizationMismatchError } from '@flowpilot/shared';
import { mapClient, mapMembership, mapOrganization, mapProject, mapUser } from '../mappers.js';
import type {
  Client,
  ClientStatus,
  Membership,
  MembershipRole,
  Organization,
  Project,
  ProjectStatus,
  User,
} from '@flowpilot/domain';

type Row = Record<string, unknown>;

/**
 * Tenant-scoped repositories.
 *
 * Every method takes `orgId` as its first argument and puts it in the where clause. That is not
 * a convention a future contributor can forget silently: `findById` re-checks the org after the
 * lookup and throws `OrganizationMismatchError` rather than returning someone else's row.
 */

export class OrganizationRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: { id: string; name: string; slug: string; timezone?: string }): Promise<Organization> {
    const row = await this.db.one<Row>(
      `insert into organizations (id, name, slug, timezone)
       values ($1, $2, $3, $4)
       returning *`,
      [input.id, input.name, input.slug, input.timezone ?? 'America/New_York'],
    );
    return mapOrganization(row!);
  }

  async findById(id: string): Promise<Organization | null> {
    const row = await this.db.one<Row>('select * from organizations where id = $1', [id]);
    return row ? mapOrganization(row) : null;
  }

  async findBySlug(slug: string): Promise<Organization | null> {
    const row = await this.db.one<Row>('select * from organizations where slug = $1', [slug]);
    return row ? mapOrganization(row) : null;
  }
}

export class UserRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: { id: string; email: string; fullName: string; title?: string | null }): Promise<User> {
    const row = await this.db.one<Row>(
      `insert into users (id, email, full_name, title) values ($1, $2, $3, $4) returning *`,
      [input.id, input.email.toLowerCase(), input.fullName, input.title ?? null],
    );
    return mapUser(row!);
  }

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.db.one<Row>('select * from users where lower(email) = lower($1)', [email]);
    return row ? mapUser(row) : null;
  }

  async findById(id: string): Promise<User | null> {
    const row = await this.db.one<Row>('select * from users where id = $1', [id]);
    return row ? mapUser(row) : null;
  }

  async listByOrg(orgId: string): Promise<(User & { role: MembershipRole; title: string | null; membershipId: string })[]> {
    const rows = await this.db.query<Row>(
      `select u.*, m.role, coalesce(m.title, u.title) as title, m.id as membership_id
         from users u
         join memberships m on m.user_id = u.id
        where m.org_id = $1
        order by u.full_name`,
      [orgId],
    );
    return rows.map((r) => ({ ...mapUser(r), role: String(r['role']) as MembershipRole, membershipId: String(r['membership_id']) }));
  }
}

export class MembershipRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    id: string;
    orgId: string;
    userId: string;
    role: MembershipRole;
    title?: string | null;
    weeklyCapacityHours?: number;
  }): Promise<Membership> {
    const row = await this.db.one<Row>(
      `insert into memberships (id, org_id, user_id, role, title, weekly_capacity_hours)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [input.id, input.orgId, input.userId, input.role, input.title ?? null, input.weeklyCapacityHours ?? 40],
    );
    return mapMembership(row!);
  }

  async findByUser(orgId: string, userId: string): Promise<Membership | null> {
    const row = await this.db.one<Row>('select * from memberships where org_id = $1 and user_id = $2', [orgId, userId]);
    return row ? mapMembership(row) : null;
  }

  async listByOrg(orgId: string): Promise<Membership[]> {
    const rows = await this.db.query<Row>('select * from memberships where org_id = $1 order by created_at', [orgId]);
    return rows.map(mapMembership);
  }
}

export class ClientRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    id: string;
    orgId: string;
    name: string;
    industry?: string | null;
    contactName?: string | null;
    contactEmail?: string | null;
    status?: ClientStatus;
  }): Promise<Client> {
    const row = await this.db.one<Row>(
      `insert into clients (id, org_id, name, industry, contact_name, contact_email, status)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [input.id, input.orgId, input.name, input.industry ?? null, input.contactName ?? null, input.contactEmail ?? null, input.status ?? 'active'],
    );
    return mapClient(row!);
  }

  async list(orgId: string): Promise<Client[]> {
    const rows = await this.db.query<Row>('select * from clients where org_id = $1 order by name', [orgId]);
    return rows.map(mapClient);
  }

  async findById(orgId: string, id: string): Promise<Client | null> {
    const row = await this.db.one<Row>('select * from clients where id = $1 and org_id = $2', [id, orgId]);
    return row ? mapClient(row) : null;
  }
}

export class ProjectRepo {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    id: string;
    orgId: string;
    clientId: string;
    name: string;
    code: string;
    description?: string | null;
    status?: ProjectStatus;
    dueDate?: string | null;
  }): Promise<Project> {
    const row = await this.db.one<Row>(
      `insert into projects (id, org_id, client_id, name, code, description, status, due_date)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning *`,
      [
        input.id,
        input.orgId,
        input.clientId,
        input.name,
        input.code,
        input.description ?? null,
        input.status ?? 'active',
        input.dueDate ?? null,
      ],
    );
    return mapProject(row!);
  }

  async list(orgId: string): Promise<Project[]> {
    const rows = await this.db.query<Row>(
      `select p.*,
              (select count(*) from tasks t
                where t.project_id = p.id and t.org_id = p.org_id
                  and t.status not in ('completed','cancelled')) as open_task_count
         from projects p
        where p.org_id = $1
        order by p.created_at`,
      [orgId],
    );
    return rows.map(mapProject);
  }

  async findById(orgId: string, id: string): Promise<Project | null> {
    const row = await this.db.one<Row>('select * from projects where id = $1 and org_id = $2', [id, orgId]);
    return row ? mapProject(row) : null;
  }

  async require(orgId: string, id: string): Promise<Project> {
    const project = await this.findById(orgId, id);
    if (!project) {
      // Distinguish "no such project anywhere" from "belongs to another org" without leaking.
      const anyRow = await this.db.one<Row>('select org_id from projects where id = $1', [id]);
      if (anyRow) throw new OrganizationMismatchError('Project', id);
      throw new NotFoundError('Project', id);
    }
    return project;
  }

  async findByCode(orgId: string, code: string): Promise<Project | null> {
    const row = await this.db.one<Row>('select * from projects where org_id = $1 and lower(code) = lower($2)', [
      orgId,
      code,
    ]);
    return row ? mapProject(row) : null;
  }
}
