import type { SqlClient } from './client.js';
import { ClientRepo, MembershipRepo, OrganizationRepo, ProjectRepo, UserRepo } from './repos/tenant.js';
import { RequestRepo } from './repos/requests.js';
import { TaskRepo } from './repos/tasks.js';
import { TaskOperationsRepo } from './repos/task-operations.js';
import { ApprovalRepo, WorkflowRunRepo } from './repos/workflow.js';
import { AuditRepo, CredentialRepo, IntegrationRepo } from './repos/platform.js';
import { AiProviderSettingsRepo } from './repos/ai-provider-settings.js';
import {
  BusinessHoursRepo,
  FaqRepo,
  LeadRepo,
  OutboundActionRepo,
  ProductRepo,
} from './repos/outbound.js';
import { OAuthStateRepo, OAuthTokenRepo, SyncCursorRepo } from './repos/oauth.js';
import { IntegrationSecretRepo } from './repos/integration-secrets.js';

export interface Repositories {
  organizations: OrganizationRepo;
  users: UserRepo;
  memberships: MembershipRepo;
  clients: ClientRepo;
  projects: ProjectRepo;
  requests: RequestRepo;
  tasks: TaskRepo;
  taskOperations: TaskOperationsRepo;
  workflowRuns: WorkflowRunRepo;
  approvals: ApprovalRepo;
  audit: AuditRepo;
  credentials: CredentialRepo;
  integrations: IntegrationRepo;
  aiProviderSettings: AiProviderSettingsRepo;
  outboundActions: OutboundActionRepo;
  leads: LeadRepo;
  products: ProductRepo;
  faqs: FaqRepo;
  businessHours: BusinessHoursRepo;
  oauthStates: OAuthStateRepo;
  oauthTokens: OAuthTokenRepo;
  syncCursors: SyncCursorRepo;
  integrationSecrets: IntegrationSecretRepo;
}

export function createRepositories(db: SqlClient): Repositories {
  return {
    organizations: new OrganizationRepo(db),
    users: new UserRepo(db),
    memberships: new MembershipRepo(db),
    clients: new ClientRepo(db),
    projects: new ProjectRepo(db),
    requests: new RequestRepo(db),
    tasks: new TaskRepo(db),
    taskOperations: new TaskOperationsRepo(db),
    workflowRuns: new WorkflowRunRepo(db),
    approvals: new ApprovalRepo(db),
    audit: new AuditRepo(db),
    credentials: new CredentialRepo(db),
    integrations: new IntegrationRepo(db),
    aiProviderSettings: new AiProviderSettingsRepo(db),
    outboundActions: new OutboundActionRepo(db),
    leads: new LeadRepo(db),
    products: new ProductRepo(db),
    faqs: new FaqRepo(db),
    businessHours: new BusinessHoursRepo(db),
    oauthStates: new OAuthStateRepo(db),
    oauthTokens: new OAuthTokenRepo(db),
    syncCursors: new SyncCursorRepo(db),
    integrationSecrets: new IntegrationSecretRepo(db),
  };
}
