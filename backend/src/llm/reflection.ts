// Reflection orchestrator. Once per game-day the game-loop calls runReflection
// in the background; it pulls the day's events, asks Ollama to synthesize
// natural-language rules, and persists them via RuleRepo. Active rules are
// then injected into subsequent feed prompts as the "Lessons" block.
//
// Failure handling: any error path (Ollama down, parse fail, empty rules) just
// logs and returns. The lineage simply doesn't gain new rules that day — the
// next reflection cycle will try again. The character side never blocks on
// reflection, so a slow/dead Ollama can't freeze gameplay.

import type { EventRepo } from '../event-repo.js';
import type { RuleRepo } from '../rule-repo.js';
import { generate, type OllamaOptions } from './ollama-client.js';
import { buildReflectionPrompt } from './prompt-reflection.js';

// Reflection budget — runs in background, so longer is fine. The prompt is
// bigger than a feed call (full day of events) and we want it to actually
// think, so 90s leaves room for cold-start + a fat day.
const REFLECTION_TIMEOUT_MS = 90_000;

type RuleEmit = { text: string; confidence: number };
type ReflectionPayload = { rules: RuleEmit[]; summary?: string };

export type ReflectionInput = {
  lineageId: number;
  iteration: number;
  gameDay: number;
  daySinceMs: number;
};

export type ReflectionResult =
  | { ok: true; rulesAdded: number; durationMs: number; summary: string }
  | { ok: false; reason: string };

export async function runReflection(
  input: ReflectionInput,
  ollama: OllamaOptions,
  events: EventRepo,
  rules: RuleRepo,
  log: (line: string) => void = () => {},
): Promise<ReflectionResult> {
  const dayEvents = events.loadSince(input.daySinceMs);
  if (dayEvents.length === 0) {
    log('[reflection] skipped — no events recorded today');
    return { ok: false, reason: 'no events' };
  }

  const priorRules = rules.loadActive(input.lineageId);
  const prompt = buildReflectionPrompt(input.gameDay, input.iteration, dayEvents, priorRules);

  const res = await generate(
    { ...ollama, timeoutMs: REFLECTION_TIMEOUT_MS },
    prompt,
    { numPredict: 600, temperature: 0.6 },
  );
  if (!res.ok) {
    log(`[reflection] LLM call failed (${res.kind}: ${res.error})`);
    return { ok: false, reason: `${res.kind}:${res.error}` };
  }

  const parsed = parsePayload(res.text);
  if (!parsed) {
    log(`[reflection] unparseable: ${res.text.slice(0, 160)}`);
    return { ok: false, reason: 'parse' };
  }

  const valid = parsed.rules.filter((r) => r.text.trim().length > 0 && r.confidence >= 0.4);
  if (valid.length === 0) {
    log('[reflection] no rules above confidence floor (0.4)');
    return { ok: false, reason: 'empty' };
  }

  const added = rules.save(input.lineageId, input.iteration, input.gameDay, valid);
  const summary = parsed.summary ?? '';
  log(
    `[reflection] D${input.gameDay} iter=${input.iteration} +${added} rules in ${res.totalDurationMs}ms — ${summary}`,
  );
  for (const r of valid) {
    log(`[reflection]   • (${r.confidence.toFixed(2)}) ${r.text}`);
  }
  return { ok: true, rulesAdded: added, durationMs: res.totalDurationMs, summary };
}

function parsePayload(text: string): ReflectionPayload | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const arr = obj.rules;
    if (!Array.isArray(arr)) return null;
    const rules: RuleEmit[] = [];
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const t = typeof rec.text === 'string' ? rec.text.trim() : '';
      const c = typeof rec.confidence === 'number' ? rec.confidence : NaN;
      if (t.length === 0 || !Number.isFinite(c)) continue;
      rules.push({ text: t, confidence: clamp01(c) });
    }
    const summary = typeof obj.summary === 'string' ? obj.summary : undefined;
    return { rules, summary };
  } catch {
    return null;
  }
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
