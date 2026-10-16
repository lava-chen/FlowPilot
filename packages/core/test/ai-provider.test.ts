import { describe, expect, it, vi } from 'vitest';
import { ValidationError } from '@flowpilot/shared';
import { OpenAiCompatibleProvider } from '../src/ai/openai-compatible.js';
import type { AiAnalysisInput } from '../src/ai/provider.js';

const input: AiAnalysisInput = {
  request: {
    id: 'req_test_1', orgId: 'org_test', source: 'email', sourceRef: 'test', externalId: 'mail-1',
    clientId: null, projectId: null, rawFrom: 'rosa@cedarsage.co', rawSubject: 'Cedar & Sage launch cut',
    rawBody: 'Please export the 9:16 version by Friday.', rawReceivedAt: '2026-10-16T12:00:00.000Z',
    status: 'new', analysis: null, createdAt: '2026-10-16T12:00:00.000Z',
  },
  clients: [{ id: 'cli_cedar', name: 'Cedar & Sage', industry: 'Beauty' }],
  projects: [{ id: 'prj_cedar', name: 'Fall launch', code: 'CEDAR-01', clientId: 'cli_cedar', dueDate: null }],
  members: [{ id: 'usr_priya', fullName: 'Priya Natarajan', title: 'Senior Producer', role: 'manager', activeTaskCount: 2 }],
  today: '2026-10-16',
};

const validResponse = {
  clientId: 'cli_cedar', clientName: 'Cedar & Sage', projectId: 'prj_cedar', projectName: 'Fall launch',
  title: 'Cedar & Sage launch cut', description: 'Export the requested vertical version.', priority: 'normal',
  dueDate: '2026-10-23', discipline: 'edit',
  suggestedAssignee: { userId: 'usr_priya', name: 'Priya Natarajan', reason: 'Producer owns the launch handoff.', confidence: 0.7 },
  confidence: 0.82, evidence: [{ field: 'dueDate', quote: 'by Friday', confidence: 0.8 }], needsHumanReview: false,
};

describe('OpenAI-compatible analyzer', () => {
  it('tests the saved connection with a synthetic payload and no customer content', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      expect(JSON.stringify(body)).not.toContain('Cedar');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider({ baseUrl: 'https://llm.example/v1', apiKey: 'test-key', model: 'fixture-model', fetchImpl });

    await expect(provider.testConnection()).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith('https://llm.example/v1/chat/completions', expect.any(Object));
  });

  it('sends a structured request and normalizes candidate labels from trusted data', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-key');
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'fixture-model', response_format: { type: 'json_object' } });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(validResponse) } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider({ baseUrl: 'https://llm.example/v1/', apiKey: 'test-key', model: 'fixture-model', fetchImpl });

    const analysis = await provider.analyze(input);
    expect(analysis).toMatchObject({
      provider: 'openai-compatible', model: 'fixture-model', clientId: 'cli_cedar', projectId: 'prj_cedar',
      clientName: 'Cedar & Sage', projectName: 'Fall launch', suggestedAssignee: { userId: 'usr_priya' },
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://llm.example/v1/chat/completions', expect.any(Object));
  });

  it('enables MiniMax reasoning separation for both connection checks and analysis', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      const content = body.temperature === 0 ? '{"ok":true}' : JSON.stringify(validResponse);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.minimaxi.com/v1', apiKey: 'test-key', model: 'MiniMax-M2.7', fetchImpl,
    });

    await provider.testConnection();
    await provider.analyze(input);

    expect(bodies).toHaveLength(2);
    expect(bodies.every((body) => body.reasoning_split === true)).toBe(true);
  });

  it('does not send MiniMax-specific options to other OpenAI-compatible services', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 },
    )) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider({
      baseUrl: 'https://llm.example/v1', apiKey: 'test-key', model: 'fixture-model', fetchImpl,
    });

    await provider.testConnection();

    const body = JSON.parse(String((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(body).not.toHaveProperty('reasoning_split');
  });

  it('rejects a model that invents an organization member', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ ...validResponse, suggestedAssignee: { ...validResponse.suggestedAssignee, userId: 'usr_outside' } }) } }],
    }), { status: 200 });
    const provider = new OpenAiCompatibleProvider({ baseUrl: 'https://llm.example/v1', apiKey: 'test-key', model: 'fixture-model', fetchImpl });
    await expect(provider.analyze(input)).rejects.toBeInstanceOf(ValidationError);
  });
});
