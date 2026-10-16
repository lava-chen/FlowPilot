import type { RequestAnalysis, RequestRecord } from '@flowpilot/domain';
import { RequestAnalysisSchema } from '@flowpilot/domain';
import { ValidationError } from '@flowpilot/shared';

/**
 * The seam where a real LLM plugs in.
 *
 * `v0.1` ships `DeterministicAiProvider` (rule-based, offline, reproducible) so the demo never
 * depends on a network call. A real provider implements the same one method: it receives the raw
 * inbound message plus the org's clients/projects/team as grounding context, and must return a
 * `RequestAnalysis` that passes `RequestAnalysisSchema`. Nothing downstream changes.
 */
export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Safe display metadata only; provider implementations must never expose the API key here. */
  readonly baseUrl?: string;
  analyze(input: AiAnalysisInput): Promise<RequestAnalysis>;
  /** Optional synthetic connectivity probe. It must not include customer data. */
  testConnection?(): Promise<void>;
}

export interface AiAnalysisInput {
  request: RequestRecord;
  /** Candidate clients/projects — providers must pick from these, never invent ids. */
  clients: Array<{ id: string; name: string; industry: string | null }>;
  projects: Array<{ id: string; name: string; code: string; clientId: string; dueDate: string | null }>;
  members: Array<{ id: string; fullName: string; title: string | null; role: string; activeTaskCount: number }>;
  today: string;
}

/**
 * Guards any provider — including an LLM one — so a malformed or hallucinated payload fails at
 * the boundary instead of corrupting a draft.
 */
export function parseAnalysis(raw: unknown): RequestAnalysis {
  const parsed = RequestAnalysisSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`AI provider returned an invalid analysis: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}

export function parseGroundedAnalysis(raw: unknown, input: AiAnalysisInput, provider: string, model: string): RequestAnalysis {
  const payload = RequestAnalysisSchema.omit({ provider: true, model: true, createdAt: true }).safeParse(raw);
  if (!payload.success) {
    throw new ValidationError('The AI provider returned a response outside the FlowPilot analysis contract.', {
      issues: payload.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    });
  }
  const result = payload.data;
  const project = result.projectId ? input.projects.find((candidate) => candidate.id === result.projectId) : undefined;
  if (result.projectId && !project) throw new ValidationError('The AI provider selected a project outside this organization.');
  const clientId = project?.clientId ?? result.clientId;
  const client = clientId ? input.clients.find((candidate) => candidate.id === clientId) : undefined;
  if (clientId && !client) throw new ValidationError('The AI provider selected a client outside this organization.');
  if (result.clientId && project && result.clientId !== project.clientId) {
    throw new ValidationError('The AI provider paired a project with the wrong client.');
  }
  const assignee = result.suggestedAssignee?.userId
    ? input.members.find((candidate) => candidate.id === result.suggestedAssignee?.userId)
    : undefined;
  if (result.suggestedAssignee?.userId && !assignee) throw new ValidationError('The AI provider selected a team member outside this organization.');
  const sourceText = `${input.request.rawSubject}\n${input.request.rawBody}`;
  const invalidEvidence = result.evidence.filter((item) => !sourceText.includes(item.quote));
  if (invalidEvidence.length) throw new ValidationError('The AI provider returned evidence that is not present in the request.', {
    fields: invalidEvidence.map((item) => item.field),
  });
  return RequestAnalysisSchema.parse({
    ...result,
    clientId: client?.id ?? null,
    clientName: client?.name ?? null,
    projectId: project?.id ?? null,
    projectName: project?.name ?? null,
    suggestedAssignee: result.suggestedAssignee
      ? { ...result.suggestedAssignee, userId: assignee?.id ?? null, name: assignee?.fullName ?? result.suggestedAssignee.name }
      : null,
    needsHumanReview: result.needsHumanReview || result.confidence < 0.7 || !project,
    provider,
    model,
    createdAt: new Date().toISOString(),
  });
}
