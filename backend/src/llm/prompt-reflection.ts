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
survivors. A game day has just ended. You will be given that day's events plus
rules preserved from earlier days and earlier generations. Refine the set of
NATURAL-LANGUAGE rules that future generations should inherit.

Each rule MUST come from events shown below — never from these instructions.
Each rule should describe ONE of:

  • A cause: how an action you took affected a stat or condition.
  • A condition: when a particular action helped or backfired.
  • A mechanism: what a resource provides or requires.

Use the nouns and verbs that appear in your own event log. If you're tempted
to use a word from these instructions, you're copying instead of
remembering — drop it.

DO NOT write rules that:
- Are vague: e.g. "Be careful at night" (no action, no consequence)
- Are tactical thresholds: e.g. "Eat when hunger drops below 30" (the
  cognition layer decides thresholds, not lineage wisdom)
- State trivia: e.g. "Trees grow tall" (not actionable)
- Are self-referential: e.g. "I should rest more" (no causal claim)
- Are tied to specific resource ids or timestamps

Cross-reference: For each prior rule, judge whether today's events confirmed,
contradicted, or left it untested. Keep confirmed; drop or replace
contradicted; preserve untested with same confidence.

Confidence anchors:
- 0.9+: pattern observed 5+ times, no contradiction
- 0.7: observed 3-4 times, no contradiction
- 0.5: observed 1-2 times, plausible
- <0.4: don't include

Maximum 8 rules total. Quality over quantity.

For each rule: if it refines or repeats a prior rule, set "prior_idx" to that
rule's index in the numbered prior rules list. If it's brand new from today's
events, set "prior_idx" to null.

Output STRICT JSON:
{"rules":[{"text":"<sentence>","confidence":<0..1>,"prior_idx":<int_or_null>}, ...],"summary":"<one short sentence>"}`;

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
    : priorRules.map((r, i) => `${i}. "${r.text}" (confidence ${r.confidence.toFixed(2)})`).join('\n');

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
