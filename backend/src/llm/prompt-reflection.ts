// Reflection prompt — runs once per game-day. Feeds the LLM the day's event
// log (compact form) plus the rules it produced previously, and asks for a
// refined rule set the next generation can inherit.
//
// Tone is on purpose anthropomorphic: we're prompting the model AS the spirit
// of the lineage, looking back. That framing tends to produce sentences the
// feed prompt can swallow as-is ("Eating raw meat caused sickness").

import type { EventRow } from '../event-repo.js';
import type { Rule } from '../rule-repo.js';

const SYSTEM_BLOCK = `You are the spirit memory of a lineage of primitive
survivors. One generation has just finished a day of acting in the world. You
will be given that day's events and any prior rules from earlier generations.
Your job is to look across all of that and produce a small set of NATURAL-
LANGUAGE rules that the next generation should know.

Guidelines:
- Each rule is one short English sentence describing a cause→effect or a
  lasting truth ("Cooking meat at a fire makes it safe to eat").
- Prefer rules that are general and durable. Avoid rules tied to specific
  resource ids or timestamps.
- Do not invent mechanics that aren't visible in the events. If you didn't see
  it happen, don't claim it.
- Keep prior rules that the day's events confirmed; drop or replace ones the
  events contradicted; add new ones for things only this day revealed.
- Confidence is a number 0-1. 0.9+ for things observed many times with no
  contradiction; 0.5 for tentative inferences; below 0.4 don't include.
- Maximum 8 rules total. Quality over quantity.

Output STRICT JSON:
{"rules":[{"text":"<sentence>","confidence":<0..1>}, ...],"summary":"<one short sentence>"}`;

export function buildReflectionPrompt(
  gameDay: number,
  iteration: number,
  events: EventRow[],
  priorRules: Rule[],
): string {
  const eventLines = events.length === 0
    ? '(no events recorded this day)'
    : events.map(formatEvent).join('\n');

  const priorBlock = priorRules.length === 0
    ? '(no prior rules — this is the first reflection of this lineage)'
    : priorRules.map((r) => `- "${r.text}" (confidence ${r.confidence.toFixed(2)})`).join('\n');

  return `/no_think
${SYSTEM_BLOCK}

Game day just ended: D${gameDay}, generation ${iteration}.

Prior rules (from earlier generations):
${priorBlock}

Events from today (oldest first):
${eventLines}

Output JSON only.`;
}

function formatEvent(e: EventRow): string {
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(e.payload) as Record<string, unknown>;
  } catch {
    // ignore — leave empty
  }
  const compact = compactPayload(payload);
  return compact.length > 0
    ? `- ${e.game_time} ${e.event_type}: ${compact}`
    : `- ${e.game_time} ${e.event_type}`;
}

function compactPayload(p: Record<string, unknown>): string {
  // Keep the prompt readable: only show keys whose value is a primitive
  // and round numbers to 1 decimal.
  const parts: string[] = [];
  for (const [k, v] of Object.entries(p)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') parts.push(`${k}=${v}`);
    else if (typeof v === 'number') parts.push(`${k}=${Math.round(v * 10) / 10}`);
    else if (typeof v === 'boolean') parts.push(`${k}=${v}`);
  }
  return parts.join(' ');
}
