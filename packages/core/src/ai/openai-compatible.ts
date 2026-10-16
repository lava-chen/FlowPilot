import { IntegrationError } from '@flowpilot/shared';
import { parseGroundedAnalysis, type AiAnalysisInput, type AiProvider } from './provider.js';

export interface OpenAiCompatibleOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Optional OpenAI Chat Completions-compatible structured analyzer. It is only constructed when
 * explicitly selected in environment configuration; the deterministic provider remains offline by default.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = 'openai-compatible';
  readonly model: string;
  readonly baseUrl: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = `${this.baseUrl}/chat/completions`;
  }

  /** Sends a minimal structured request without customer data to verify endpoint, key and model. */
  async testConnection(): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'Return exactly this JSON object: {"ok":true}.' },
            { role: 'user', content: 'Connection check. Return {"ok":true}.' },
          ],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new IntegrationError('Could not reach the configured AI service.', {
        provider: this.name,
        cause: error instanceof Error ? error.name : 'unknown',
      });
    }
    if (!response.ok) {
      throw new IntegrationError(`The configured AI service returned HTTP ${response.status}.`, {
        provider: this.name,
        status: response.status,
      });
    }
    let envelope: unknown;
    try { envelope = await response.json(); }
    catch { throw new IntegrationError('The AI service returned an invalid connection-check response.', { provider: this.name }); }
    let content: unknown;
    try { content = JSON.parse(readContent(envelope)); }
    catch { throw new IntegrationError('The AI service did not return the expected structured response.', { provider: this.name }); }
    if (!content || typeof content !== 'object' || (content as { ok?: unknown }).ok !== true) {
      throw new IntegrationError('The AI service did not return the expected structured response.', { provider: this.name });
    }
  }

  async analyze(input: AiAnalysisInput) {
    const system = [
      'You are a structured intake analyst for a creative agency task system.',
      'Return exactly one JSON object matching the requested schema. Do not return markdown.',
      'Choose clientId, projectId, and suggestedAssignee.userId only from the supplied candidates; use null when uncertain.',
      'Project and client must agree. Never invent a due date; use null unless the request states one.',
      'Evidence quotes must be exact substrings of the supplied subject or body. Set needsHumanReview when important fields are uncertain.',
      'The confidence value is a cautious estimate, not a measured probability.',
    ].join(' ');
    const user = {
      today: input.today,
      request: { from: input.request.rawFrom, subject: input.request.rawSubject, body: input.request.rawBody },
      candidates: { clients: input.clients, projects: input.projects, team: input.members },
      requiredShape: {
        clientId: 'string|null', clientName: 'string|null', projectId: 'string|null', projectName: 'string|null',
        title: 'string (3-200 chars)', description: 'string (max 4000 chars)', priority: 'low|normal|high|urgent',
        dueDate: 'YYYY-MM-DD|null', discipline: 'edit|shoot|design|copy|strategy|sound|unknown',
        suggestedAssignee: '{userId:string|null,name:string,reason:string,confidence:number}|null',
        confidence: 'number 0..1', evidence: 'array of {field,quote,confidence}', needsHumanReview: 'boolean',
      },
    };

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.1,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(user) }],
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new IntegrationError('The configured AI provider could not be reached.', {
        provider: this.name, cause: error instanceof Error ? error.name : 'unknown',
      });
    }
    if (!response.ok) {
      throw new IntegrationError(`The configured AI provider returned HTTP ${response.status}.`, { provider: this.name, status: response.status });
    }
    let envelope: unknown;
    try { envelope = await response.json(); }
    catch { throw new IntegrationError('The configured AI provider returned invalid JSON.', { provider: this.name }); }

    const content = readContent(envelope);
    let parsed: unknown;
    try { parsed = JSON.parse(content); }
    catch { throw new IntegrationError('The configured AI provider response was not a JSON analysis object.', { provider: this.name }); }
    return parseGroundedAnalysis(parsed, input, this.name, this.model);
  }
}

function readContent(envelope: unknown): string {
  if (!envelope || typeof envelope !== 'object') throw new IntegrationError('The AI provider response has no choices.', { provider: 'openai-compatible' });
  const choices = (envelope as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) throw new IntegrationError('The AI provider response has no choices.', { provider: 'openai-compatible' });
  const message = (choices[0] as { message?: { content?: unknown } })?.message;
  if (!message || typeof message.content !== 'string') throw new IntegrationError('The AI provider response has no text content.', { provider: 'openai-compatible' });
  return message.content;
}
