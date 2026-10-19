import type { FlowPilotDb } from '@flowpilot/database';
import { AuditService } from './audit.service.js';
import { CredentialService } from './credential.service.js';
import { IngestionService } from './ingestion.service.js';
import { QueryService } from './query.service.js';
import { TaskService } from './task.service.js';
import { WorkflowService } from './workflow.service.js';
import { ApprovalService } from './approval.service.js';
import { OutboundActionService } from './outbound-action.service.js';
import { IntegrationService } from './integration.service.js';
import { WhatsAppReplyService } from './whatsapp-reply.service.js';
import { OAuthService, type OutlookProviderConfig, OUTLOOK_DEFAULT_SCOPES } from './outlook-oauth.service.js';
import { OutlookSyncService } from './outlook-sync.service.js';
import { DeterministicAiProvider } from './ai/deterministic.js';
import { TaskOperationsService } from './task-operations.service.js';
import type { AiProvider } from './ai/provider.js';
import { AiProviderSettingsService } from './ai/settings.service.js';
import type { Actor } from '@flowpilot/domain';

/**
 * The composition root for business services.
 *
 * Both apps build their services here, from a connection. Services stay org-agnostic: every
 * method takes an `Actor` and derives `orgId` from it, and the services that record workflow runs
 * receive a `WorkflowFactory` so they can bind a run recorder to the caller's organization.
 *
 * That is what lets the MCP server and the dashboard run *the same objects* against the same
 * database with no shared mutable state.
 */
export type WorkflowFactory = (actor: Actor) => WorkflowService;

export interface CoreServices {
  db: FlowPilotDb;
  ai: AiProvider;
  aiSettings: AiProviderSettingsService;
  aiFor(actor: Actor): Promise<AiProvider>;
  audit: AuditService;
  workflowsFor: WorkflowFactory;
  requests: IngestionService;
  tasks: TaskService;
  taskOperations: TaskOperationsService;
  approvals: ApprovalService;
  credentials: CredentialService;
  queries: QueryService;
  outbounds: OutboundActionService;
  integrations: IntegrationService;
  whatsappReply: WhatsAppReplyService;
  oauth: OAuthService;
  outlookSync: OutlookSyncService;
}

export interface CreateCoreOptions {
  db: FlowPilotDb;
  /** Override to plug in a real LLM provider. */
  ai?: AiProvider;
  /** Existing session-signing secret, used with domain separation to encrypt saved provider keys. */
  encryptionSecret?: string;
  /**
   * Microsoft Graph (Outlook) provider configuration. The service is *constructed* even when
   * this is empty, so callers can still ask the OAuth service whether the env is configured; the
   * service throws `NotFoundError` when no entry matches the requested provider.
   */
  outlookProvider?: OutlookProviderConfig;
}

export function createCoreServices({
  db,
  ai = new DeterministicAiProvider(),
  encryptionSecret,
  outlookProvider,
}: CreateCoreOptions): CoreServices {
  const audit = new AuditService(db);
  const workflowsFor: WorkflowFactory = (actor) => new WorkflowService(db, actor.orgId);
  const taskOperations = new TaskOperationsService(db, audit);
  const aiSettings = new AiProviderSettingsService(db, audit, ai, encryptionSecret);
  const outbounds = new OutboundActionService(db, audit);
  const integrations = new IntegrationService(db, audit);
  const whatsappReply = new WhatsAppReplyService({ db, integrations });
  const oauth = new OAuthService({
    db,
    audit,
    rootSecret: encryptionSecret ?? '',
    providers: outlookProvider ? { 'outlook-graph': outlookProvider } : {},
  });
  const outlookSync = new OutlookSyncService({
    db,
    audit,
    oauth,
    graphProvider: outlookProvider,
  });

  return {
    db,
    ai,
    aiSettings,
    aiFor: (actor) => aiSettings.resolveProvider(actor),
    audit,
    workflowsFor,
    requests: new IngestionService(db, workflowsFor, audit),
    tasks: new TaskService(db, audit, workflowsFor, taskOperations),
    taskOperations,
    approvals: new ApprovalService(db, audit, workflowsFor),
    credentials: new CredentialService(db, audit),
    queries: new QueryService(db, taskOperations),
    outbounds,
    integrations,
    whatsappReply,
    oauth,
    outlookSync,
  };
}

/**
 * Helper for callers that boot the env once and want to hand FlowPilot the
 * Microsoft Graph configuration as `CreateCoreOptions` expects.
 */
export function outlookProviderFromEnv(env: {
  FLOWPILOT_OUTLOOK_CLIENT_ID?: string;
  FLOWPILOT_OUTLOOK_CLIENT_SECRET?: string;
  FLOWPILOT_OUTLOOK_TENANT_ID?: string;
  FLOWPILOT_OUTLOOK_REDIRECT_URI?: string;
}): OutlookProviderConfig | undefined {
  if (!env.FLOWPILOT_OUTLOOK_CLIENT_ID || !env.FLOWPILOT_OUTLOOK_TENANT_ID || !env.FLOWPILOT_OUTLOOK_REDIRECT_URI) {
    return undefined;
  }
  const config: OutlookProviderConfig = {
    clientId: env.FLOWPILOT_OUTLOOK_CLIENT_ID,
    tenantId: env.FLOWPILOT_OUTLOOK_TENANT_ID,
    redirectUri: env.FLOWPILOT_OUTLOOK_REDIRECT_URI,
    scopes: OUTLOOK_DEFAULT_SCOPES,
  };
  if (env.FLOWPILOT_OUTLOOK_CLIENT_SECRET) {
    config.clientSecret = env.FLOWPILOT_OUTLOOK_CLIENT_SECRET;
  }
  return config;
}
