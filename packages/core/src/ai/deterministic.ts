import type { Priority, RequestAnalysis } from '@flowpilot/domain';
import { addDays, nowIso } from '@flowpilot/shared';
import { parseAnalysis, type AiAnalysisInput, type AiProvider } from './provider.js';

/**
 * Deterministic, offline "analysis".
 *
 * This is explicitly **not** a language model. It is a transparent rule engine over the email
 * text, and it is here for three reasons: the demo must work with no API key and no network,
 * tests need reproducible output, and the AI Provider seam should be provably real rather than a
 * comment. Swap in an LLM implementation of `AiProvider` and the rest of the system is unchanged.
 *
 * The output shape is identical to what a structured-output LLM call would return, including
 * per-field confidence and quoted evidence, so the UI can already present uncertainty honestly.
 */
export class DeterministicAiProvider implements AiProvider {
  readonly name = 'deterministic';
  readonly model = 'rule-based-v1';

  async analyze(input: AiAnalysisInput): Promise<RequestAnalysis> {
    const text = `${input.request.rawSubject}\n${input.request.rawBody}`;
    const lower = text.toLowerCase();

    // Project first, client second. Agencies routinely keep one client row per division, so
    // matching the client first would resolve "Harbor Coffee Co." and then never find the
    // project that belongs to "Harbor Coffee Co. — Retail".
    const project = this.matchProject(lower, input);
    const client = project
      ? {
          id: project.clientId,
          name: input.clients.find((c) => c.id === project.clientId)?.name ?? null,
          // The client is inferred from the project, so it can never be more confident than it.
          quote: project.quote,
          confidence: Math.min(project.confidence, 0.85),
        }
      : this.matchClient(lower, input, input.request.rawFrom);
    const priority = this.inferPriority(lower);
    const discipline = this.inferDiscipline(lower);
    const dueDate = this.inferDueDate(lower, input.today, priority);
    const assignee = this.inferAssignee(lower, discipline, input);

    const title = this.composeTitle(input.request.rawSubject, discipline);
    const description = this.composeDescription(input.request, project?.name ?? null, assignee?.reason ?? null);

    const confidence = this.scoreConfidence({ client, project, priority, dueDate, assignee, text });

    const evidence: RequestAnalysis['evidence'] = [];
    if (client) {
      evidence.push({
        field: 'client',
        quote: client.quote,
        confidence: client.confidence,
      });
    }
    if (project) {
      evidence.push({ field: 'project', quote: project.quote, confidence: project.confidence });
    }
    const dueQuote = this.findDueQuote(text);
    if (dueQuote) evidence.push({ field: 'dueDate', quote: dueQuote, confidence: 0.55 });
    if (assignee?.quote) {
      evidence.push({ field: 'assignee', quote: assignee.quote, confidence: assignee.confidence });
    }

    return parseAnalysis({
      clientId: client?.id ?? null,
      clientName: client?.name ?? null,
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      title,
      description,
      priority,
      dueDate,
      discipline,
      suggestedAssignee: assignee
        ? {
            userId: assignee.id,
            name: assignee.name,
            reason: assignee.reason,
            confidence: assignee.confidence,
          }
        : null,
      confidence,
      evidence,
      // Anything the engine could not ground confidently is handed to a human instead of being
      // quietly assumed.
      needsHumanReview: !project || !client || confidence < 0.7,
      provider: this.name,
      model: this.model,
      createdAt: nowIso(),
    });
  }

  /* ------------------------------------------------------------------ */

  private matchClient(lower: string, input: AiAnalysisInput, sender: string) {
    // 1. The brand is named in the message ("Lumen", "Cedar & Sage").
    for (const client of input.clients) {
      const tokens = this.nameTokens(client.name);
      const hit = tokens.find((t) => lower.includes(t));
      if (hit) return { id: client.id, name: client.name, quote: hit, confidence: 0.9 };
    }

    // 2. Nobody names the client, but the sender address usually does:
    //    "alice@harborcoffee.com" -> Harbor Coffee Co.
    //    Kept at low confidence, and only when it resolves to a single candidate.
    const domain = senderDomain(sender);
    if (!domain) return null;

    const domainTokens = domain.split(/[^a-z0-9]+/).filter((t) => t.length > 3);
    if (domainTokens.length === 0) return null;

    const candidates = input.clients.filter((client) => {
      const nameTokens = this.nameTokens(client.name);
      // Match on parts of the domain ("harbor", "coffee" out of "harborcoffee"), since
      // registrable domains rarely contain the brand's spaces.
      return nameTokens.some((token) => domain.includes(token));
    });
    if (candidates.length !== 1) return null;

    const chosen = candidates[0];
    if (!chosen) return null;
    return { id: chosen.id, name: chosen.name, quote: sender.trim(), confidence: 0.45 };
  }

  /** Meaningful tokens of an organization name: drops stopwords and single letters. */
  private nameTokens(name: string): string[] {
    return name
      .toLowerCase()
      .replace(/&/g, ' and ')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 3 && !['company', 'studio', 'group', 'agency'].includes(t));
  }

  private matchProject(lower: string, input: AiAnalysisInput) {
    // An explicit project code in the subject line is unambiguous.
    for (const project of input.projects) {
      if (lower.includes(project.code.toLowerCase())) {
        return { id: project.id, name: project.name, clientId: project.clientId, quote: project.code, confidence: 0.95 };
      }
    }

    // Otherwise score by how many distinctive name tokens appear in the message.
    const scored = input.projects
      .map((project) => {
        const tokens = this.nameTokens(project.name).filter((t) => !GENERIC_PROJECT_WORDS.has(t));
        const hits = tokens.filter((t) => lower.includes(t));
        const distinctive = hits.some((t) => t.length >= 6);
        return { project, hits, distinctive };
      })
      .filter((candidate) => candidate.hits.length >= 2 || (candidate.hits.length === 1 && candidate.distinctive))
      .sort((a, b) => b.hits.length - a.hits.length || a.project.id.localeCompare(b.project.id));

    const best = scored[0];
    if (!best) return null;

    return {
      id: best.project.id,
      name: best.project.name,
      clientId: best.project.clientId,
      quote: best.hits.join(' '),
      confidence: best.hits.length >= 2 ? 0.8 : 0.65,
    };
  }

  private inferPriority(lower: string): Priority {
    if (/(asap|urgent|right away|immediately|chasing|overdue|escalat|blocking)/.test(lower)) return 'urgent';
    if (/(urgent|high priority|priority|before the .*flight|paid flight|deadline|by thursday|by friday|today|asap)/.test(lower)) return 'high';
    if (/(not urgent|no rush|whenever|low priority|eventually)/.test(lower)) return 'low';
    return 'normal';
  }

  private inferDiscipline(lower: string): RequestAnalysis['discipline'] {
    if (/(recut|recut|re-?edit|revision|revise|cut|edit|trim|end card|reel|aspect ratio|caption)/.test(lower)) return 'edit';
    if (/(shoot|filming|shoot day|on location|footage|capture)/.test(lower)) return 'shoot';
    if (/(retouch|grade|color grade|design|mockup|lut)/.test(lower)) return 'design';
    if (/(caption|copy|script|voiceover|headline|tagline)/.test(lower)) return 'copy';
    if (/(sound|music|audio|licen[cs]e the track)/.test(lower)) return 'sound';
    if (/(strategy|concept|creative direction|campaign plan)/.test(lower)) return 'strategy';
    return 'unknown';
  }

  private inferDueDate(lower: string, today: string, priority: Priority): string | null {
    const base = new Date(`${today}T00:00:00.000Z`);
    if (/(today|end of day|eod)/.test(lower)) return today;
    if (/tomorrow/.test(lower)) return addDays(base, 1).toISOString().slice(0, 10);

    const inDays = lower.match(/within (\d{1,3}) days?/);
    if (inDays?.[1]) return addDays(base, Number(inDays[1])).toISOString().slice(0, 10);

    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    for (const [index, day] of weekdays.entries()) {
      if (lower.includes(day)) {
        const current = base.getUTCDay();
        let delta = (index - current + 7) % 7;
        if (delta === 0) delta = 7;
        return addDays(base, delta).toISOString().slice(0, 10);
      }
    }

    // No date in the text: urgency is the only honest signal we have, so say so explicitly
    // rather than inventing a date.
    if (priority === 'urgent') return addDays(base, 1).toISOString().slice(0, 10);
    return null;
  }

  private inferAssignee(
    lower: string,
    discipline: RequestAnalysis['discipline'],
    input: AiAnalysisInput,
  ) {
    // 1. Named in the message ("Marcus, can Priya…").
    for (const member of input.members) {
      const first = member.fullName.split(' ')[0]?.toLowerCase() ?? '';
      if (first.length > 3 && lower.includes(first)) {
        return {
          id: member.id,
          name: member.fullName,
          reason: `Named directly in the request.`,
          confidence: 0.9,
          quote: member.fullName,
        };
      }
    }

    if (!discipline) return null;

    // 2. Least-loaded member whose title matches the discipline. Deterministic tie-breaks on id
    //    so the same input always yields the same suggestion.
    const relevant = input.members.filter((member) => {
      if (member.role === 'owner') return false;
      const title = (member.title ?? '').toLowerCase();
      if (discipline === 'edit') return /(editor|editor|motion)/.test(title);
      if (discipline === 'shoot') return /(producer)/.test(title);
      if (discipline === 'design') return /(designer|producer|editor)/.test(title);
      if (discipline === 'sound') return /(sound|audio)/.test(title);
      if (discipline === 'copy') return /(copy|writer)/.test(title);
      return true;
    });

    const pool = relevant.length > 0 ? relevant : input.members.filter((m) => m.role !== 'owner');
    if (pool.length === 0) return null;

    const sorted = [...pool].sort(
      (a, b) => a.activeTaskCount - b.activeTaskCount || a.id.localeCompare(b.id),
    );
    const chosen = sorted[0];
    if (!chosen) return null;

    return {
      id: chosen.id,
      name: chosen.fullName,
      reason: `Lowest open workload (${chosen.activeTaskCount} active) among ${
        discipline === 'unknown' ? 'available crew' : `${discipline} crew`
      }.`,
      confidence: 0.5,
      quote: null,
    };
  }

  private composeTitle(subject: string, discipline: RequestAnalysis['discipline']): string {
    const cleaned = subject
      .replace(/^(re|fwd|fw)\s*:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    const base = cleaned.length >= 8 ? cleaned : `${capitalize(discipline === 'unknown' ? 'New request' : discipline)} — ${cleaned}`;
    return base.slice(0, 160);
  }

  private composeDescription(
    request: { rawFrom: string; rawBody: string },
    projectName: string | null,
    assigneeReason: string | null,
  ): string {
    const body = request.rawBody.trim();
    const parts = [
      `Inbound request from ${request.rawFrom}${projectName ? ` for ${projectName}` : ''}.`,      '',
      body,
    ];
    if (assigneeReason) {
      parts.push('', `Suggested assignment: ${assigneeReason} (proposed by the rule-based analyzer, verify before approving).`);
    }
    return parts.join('\n').slice(0, 4000);
  }

  private scoreConfidence(input: {
    client: { confidence: number } | null;
    project: { confidence: number } | null;
    priority: Priority;
    dueDate: string | null;
    assignee: { confidence: number } | null;
    text: string;
  }): number {
    let score = 0.3;
    if (input.client) score += 0.2;
    if (input.project) score += 0.25;
    if (input.dueDate) score += 0.1;
    if (input.assignee) score += input.assignee.confidence * 0.1;
    if (input.priority === 'urgent' || input.priority === 'high') score += 0.05;
    if (input.text.length > 400) score += 0.05;
    return Math.min(0.95, Number(score.toFixed(2)));
  }

  private findDueQuote(text: string): string | null {
    const match = text.match(/[^.\n]*\b(by (monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|today|end of day|within \d+ days?)[^.\n]*/i);
    return match ? match[0].trim().slice(0, 200) : null;
  }
}

const GENERIC_PROJECT_WORDS = new Set(['series', 'launch', 'batch', 'teaser', 'refresh', 'campaign']);

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** "Alice <alice@harborcoffee.com>" -> "harborcoffee" */
function senderDomain(sender: string): string | null {
  const match = sender.match(/@([A-Za-z0-9.-]+)/);
  const domain = match?.[1]?.toLowerCase();
  if (!domain) return null;
  const [first = ''] = domain.split('.');
  return first || null;
}
