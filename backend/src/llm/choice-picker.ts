// Decision layer for the "feed" need. Threshold logic in `ai.decide()` figures
// out *that* the character needs to eat (hunger <= trigger). This module
// figures out *what* the character should eat — picking from a pre-built list
// of reachable options with their costs and gains.
//
// Two implementations:
// - `RuleBasedChoicePicker`: original 10-step priority ladder, deterministic.
// - `LlmChoicePicker`: sends options + character state to a local LLM (Qwen3
//   via Ollama) which picks one and explains why. Falls back to rule on any
//   error so the character never freezes when Ollama is down.

import type { Action, Character, Position } from '../../../shared/types.js';
import { generate, type OllamaOptions } from './ollama-client.js';
import { buildFeedPrompt } from './prompt-feed.js';
import { buildWanderPrompt } from './prompt-wander.js';

export type FeedKind =
  | 'eat_meat_cooked'
  | 'eat_meat_raw_panic'    // hunger critical, accept sickness risk
  | 'cook_meat'
  | 'eat_berry_inv'
  | 'eat_fruit_inv'
  | 'eat_meat_raw_normal'
  | 'hunt'
  | 'pickup_fruit_ground'
  | 'forage_bush'
  | 'shake_tree'
  | 'pickup_wood';

export type FeedOption = {
  kind: FeedKind;
  target?: string;
  path: Position[];
  distance: number;
  finalAction: Action;
};

// One past action and what it did to the character. Fed to the LLM as a log
// so it can induce mechanics from its own history (shake_tree → 0 hunger,
// eat_fruit → +5 hunger) instead of being told them in the prompt.
export type Observation = {
  t: string;          // game-time stamp, e.g. "D2 14:30"
  action: string;     // chosen feed kind or finalAction.type
  target?: string;
  dHunger?: number;
  dThirst?: number;
  dEnergy?: number;
  dSickness?: number;
  inv?: string;       // e.g. "+1fruit" or "-1berry,+1wood"
};

export type FeedContext = {
  character: Character;
  options: FeedOption[];
  observations: Observation[];
  // Natural-language rules emitted by the reflection cycle, persisted in the
  // `rule` table. Empty until the first reflection completes. Injected into
  // the feed prompt as the "Lessons from past lives" block.
  rules: string[];
};

export type FeedChoiceResult = {
  option: FeedOption;
  reasoning?: string;
  source: 'rule' | 'llm';
  llmDurationMs?: number;
  // Daily-goal self-tag (LLM-source only). When the model reports it picked an
  // action that completes the active sub-goal, game-loop bumps the plan via
  // DailyGoalRepo.advanceStep on this index. Null/undefined when the model
  // didn't tag (or when the rule fallback was used).
  advancesSubgoalIdx?: number | null;
  completesSubgoal?: boolean | null;
};

// Direction-keyed wander option. Engine pre-computes the 8 cardinal+ordinal
// rays plus an at-position "stay", annotates each with what's nearby per
// spatial memory, and the picker chooses one. Annotations are perceptual
// hints — "unexplored" / "near_tree(age=4h)" / "near_edge" / "at_pos" — so
// the LLM (or rule fallback) can reason about exploration vs revisit.
export type WanderKind =
  | 'wander_n'
  | 'wander_ne'
  | 'wander_e'
  | 'wander_se'
  | 'wander_s'
  | 'wander_sw'
  | 'wander_w'
  | 'wander_nw'
  | 'stay';

export type WanderOption = {
  kind: WanderKind;
  target: Position;
  path: Position[];
  distance: number;
  annotation: string;
  isUnexplored: boolean;
};

export type WanderContext = {
  character: Character;
  options: WanderOption[];
  rememberedSummary: string;
};

export type WanderChoiceResult = {
  option: WanderOption;
  reasoning?: string;
  source: 'rule' | 'llm';
  llmDurationMs?: number;
  advancesSubgoalIdx?: number | null;
  completesSubgoal?: boolean | null;
};

export interface ChoicePicker {
  pickFeed(ctx: FeedContext): Promise<FeedChoiceResult | null>;
  pickWander(ctx: WanderContext): Promise<WanderChoiceResult | null>;
}

const RULE_PRIORITY: FeedKind[] = [
  'eat_meat_cooked',
  'eat_meat_raw_panic',
  'cook_meat',
  'eat_berry_inv',
  'eat_fruit_inv',
  'eat_meat_raw_normal',
  'hunt',
  'pickup_fruit_ground',
  'forage_bush',
  'shake_tree',
  'pickup_wood',
];

export class RuleBasedChoicePicker implements ChoicePicker {
  async pickFeed(ctx: FeedContext): Promise<FeedChoiceResult | null> {
    if (ctx.options.length === 0) return null;
    for (const kind of RULE_PRIORITY) {
      const matches = ctx.options.filter((o) => o.kind === kind);
      if (matches.length === 0) continue;
      matches.sort((a, b) => a.distance - b.distance);
      return { option: matches[0], source: 'rule' };
    }
    return null;
  }

  async pickWander(ctx: WanderContext): Promise<WanderChoiceResult | null> {
    if (ctx.options.length === 0) return null;
    const unexplored = ctx.options.filter((o) => o.isUnexplored && o.kind !== 'stay');
    const pool = unexplored.length > 0 ? unexplored : ctx.options.filter((o) => o.kind !== 'stay');
    if (pool.length === 0) return { option: ctx.options[0], source: 'rule' };
    const choice = pool[Math.floor(Math.random() * pool.length)];
    return { option: choice, source: 'rule' };
  }
}

export class LlmChoicePicker implements ChoicePicker {
  constructor(
    private ollama: OllamaOptions,
    private fallback: ChoicePicker,
    private onLog: (line: string) => void = () => {},
  ) {}

  async pickFeed(ctx: FeedContext): Promise<FeedChoiceResult | null> {
    if (ctx.options.length === 0) return null;
    // Skip LLM round-trip when there's nothing to choose between — saves ~2s
    // on the trivial path where the only option is "eat the cooked meat
    // already in your inventory".
    if (ctx.options.length === 1) {
      return { option: ctx.options[0], source: 'rule' };
    }

    const prompt = buildFeedPrompt(ctx.character, ctx.options, ctx.observations, ctx.rules);
    const res = await generate(this.ollama, prompt, { numPredict: 120, temperature: 0.7 });
    if (!res.ok) {
      this.onLog(`[llm] feed call failed (${res.kind}: ${res.error}) → fallback rule`);
      return this.fallback.pickFeed(ctx);
    }

    const parsed = parseLlmResponse(res.text);
    if (!parsed) {
      this.onLog(`[llm] unparseable: ${res.text.slice(0, 120)} → fallback rule`);
      return this.fallback.pickFeed(ctx);
    }

    const match = ctx.options.find((o) => {
      if (o.kind !== parsed.choice) return false;
      if (parsed.target && o.target && parsed.target !== o.target) return false;
      return true;
    });
    if (!match) {
      this.onLog(`[llm] picked invalid kind=${parsed.choice} target=${parsed.target ?? '-'} → fallback rule`);
      return this.fallback.pickFeed(ctx);
    }
    this.onLog(`[llm] feed pick=${match.kind}${match.target ? ' target=' + match.target : ''} (${res.totalDurationMs}ms) — ${parsed.reasoning}`);
    if (parsed.completesSubgoal !== null || parsed.advancesSubgoalIdx !== null) {
      this.onLog(`[llm]   self-tag: completes_subgoal=${parsed.completesSubgoal} advances_idx=${parsed.advancesSubgoalIdx}`);
    }
    return {
      option: match,
      reasoning: parsed.reasoning,
      source: 'llm',
      llmDurationMs: res.totalDurationMs,
      advancesSubgoalIdx: parsed.advancesSubgoalIdx,
      completesSubgoal: parsed.completesSubgoal,
    };
  }

  async pickWander(ctx: WanderContext): Promise<WanderChoiceResult | null> {
    if (ctx.options.length === 0) return null;
    // Skip LLM for trivial cases — single direction reachable, or only "stay".
    // Same rationale as pickFeed: 2-3s round-trip not worth it when there's
    // nothing to choose between.
    if (ctx.options.length <= 2) {
      return this.fallback.pickWander(ctx);
    }

    const prompt = buildWanderPrompt(ctx.character, ctx.options, ctx.rememberedSummary);
    const res = await generate(this.ollama, prompt, { numPredict: 100, temperature: 0.7 });
    if (!res.ok) {
      this.onLog(`[llm] wander call failed (${res.kind}: ${res.error}) → fallback rule`);
      return this.fallback.pickWander(ctx);
    }

    const parsed = parseLlmResponse(res.text);
    if (!parsed) {
      this.onLog(`[llm] wander unparseable: ${res.text.slice(0, 120)} → fallback rule`);
      return this.fallback.pickWander(ctx);
    }

    const match = ctx.options.find((o) => o.kind === parsed.choice);
    if (!match) {
      this.onLog(`[llm] wander picked invalid kind=${parsed.choice} → fallback rule`);
      return this.fallback.pickWander(ctx);
    }
    this.onLog(`[llm] wander pick=${match.kind} (${res.totalDurationMs}ms) — ${parsed.reasoning}`);
    if (parsed.completesSubgoal !== null || parsed.advancesSubgoalIdx !== null) {
      this.onLog(`[llm]   self-tag: completes_subgoal=${parsed.completesSubgoal} advances_idx=${parsed.advancesSubgoalIdx}`);
    }
    return {
      option: match,
      reasoning: parsed.reasoning,
      source: 'llm',
      llmDurationMs: res.totalDurationMs,
      advancesSubgoalIdx: parsed.advancesSubgoalIdx,
      completesSubgoal: parsed.completesSubgoal,
    };
  }
}

type ParsedFeedResponse = {
  choice: string;
  target?: string;
  reasoning: string;
  advancesSubgoalIdx: number | null;
  completesSubgoal: boolean | null;
};

function parseLlmResponse(text: string): ParsedFeedResponse | null {
  try {
    const obj = JSON.parse(text) as Record<string, unknown>;
    const choice = typeof obj.choice === 'string' ? obj.choice : null;
    if (!choice) return null;
    const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : '';
    const target = typeof obj.target === 'string' && obj.target.length > 0 ? obj.target : undefined;
    const advRaw = obj.advances_subgoal_idx;
    const advancesSubgoalIdx =
      typeof advRaw === 'number' && Number.isFinite(advRaw) ? Math.round(advRaw) : null;
    const completesSubgoal = typeof obj.completes_subgoal === 'boolean' ? obj.completes_subgoal : null;
    return { choice, target, reasoning, advancesSubgoalIdx, completesSubgoal };
  } catch {
    return null;
  }
}
