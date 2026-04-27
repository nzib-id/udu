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
import type { CortexOption } from '../ai.js';
import { generate, type OllamaOptions } from './ollama-client.js';
import { buildFeedPrompt } from './prompt-feed.js';
import { buildWanderPrompt } from './prompt-wander.js';
import { buildCortexPrompt } from './prompt-cortex.js';

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
  // Optional perceptual annotation rendered to the LLM, e.g.
  // "expected=+5hunger" for in-place consumes. Only the consume kinds set
  // this; gather/walk options leave it undefined.
  annotation?: string;
};

// One past action and what it did to the character. Fed to the LLM as a log
// so it can induce mechanics from its own history (shake → 0 hunger,
// eat fruit → +5 hunger) instead of being told them in the prompt.
export type Observation = {
  t: string;          // game-time stamp, e.g. "D2 14:30"
  action: string;     // chosen feed kind or finalAction.type
  target?: string;
  dHunger?: number;
  dThirst?: number;
  dEnergy?: number;
  dSickness?: number;
  inv?: string;       // e.g. "+1fruit" or "-1berry,+1wood"
  // Set by action handlers when an action runs but cannot complete (precondition
  // miss). Replaces the generic "no visible effect" tail with a perception-level
  // reason so the LLM doesn't keep retrying — e.g. "tree appears empty" instead
  // of silent failure. See prompt-cortex.ts:formatObservation.
  failReason?: string;
};

// World-derived facts the LLM should be aware of beyond char-only stats.
// fireStatus = pre-formatted line like "Fire: 12/24 wood, lit, 4 tiles away"
// or null when no fire is on the map.
export type WorldStatus = {
  fireStatus: string | null;
};

export type FeedContext = {
  character: Character;
  options: FeedOption[];
  observations: Observation[];
  // Natural-language rules emitted by the reflection cycle, persisted in the
  // `rule` table. Empty until the first reflection completes. Injected into
  // the feed prompt as the "Lessons from past lives" block.
  rules: string[];
  world: WorldStatus;
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
  | 'stay'
  // Pre-emptive consumption — LLM full agency. Char can pick these
  // even when hunger/thirst haven't crossed the safety-net threshold.
  | 'eat_berry_inv'
  | 'eat_fruit_inv'
  | 'drink_river'
  // Pre-emptive maintenance — relieve bladder before sickness funnel kicks in,
  // or move into the fire warmth radius before body temp slips out of comfort.
  | 'pee_now'
  | 'warm_at_fire'
  // Pre-emptive resource fetch — grab wood before fire dies (surfaced when
  // fire unlit OR fuel < maxFuel/2 AND char can carry wood).
  | 'pickup_wood'
  // Pickup branch / vine / stone off the ground (Phase A resource overhaul).
  // branch = primary fire fuel (lighter than wood), vine = future crafting,
  // stone = future axe craft (Phase B). Stone is one-shot scatter only;
  // boulder mining is deferred until craft system lands.
  | 'pickup_branch'
  | 'pickup_vine'
  | 'pickup_stone'
  // Shake tree_wood / tree_vine — non-food shakes surfaced from wander side
  // since they don't satisfy hunger. tree_fruit shake stays in FeedKind as
  // 'shake_tree'. All three dispatch the same `shake_tree` action; engine
  // branches by tree.type.
  | 'shake_tree_wood'
  | 'shake_tree_vine'
  // Pre-emptive sleep — surfaced at night when char is near a lit fire.
  // Encourages "sleep at night by the fire" instead of letting energy crash
  // into the reactive sleep trigger during the day.
  | 'sleep_now'
  // Drop one item of the named type from inventory. Frees weight so char can
  // pick up something else (e.g. drop wood to make room for berry).
  | `drop_${string}`;

export type WanderOption = {
  kind: WanderKind;
  target: Position;
  path: Position[];
  distance: number;
  annotation: string;
  isUnexplored: boolean;
  // For consume options: the action to dispatch when picked. Direction-kinds
  // and 'stay' leave this undefined and use their path as movement.
  finalAction?: Action;
};

export type WanderContext = {
  character: Character;
  options: WanderOption[];
  rememberedSummary: string;
  world: WorldStatus;
  observations: Observation[];
};

export type WanderChoiceResult = {
  option: WanderOption;
  reasoning?: string;
  source: 'rule' | 'llm';
  llmDurationMs?: number;
  advancesSubgoalIdx?: number | null;
  completesSubgoal?: boolean | null;
};

export type CortexContext = {
  character: Character;
  options: CortexOption[];
  observations: Observation[];
  rules: string[];
  world: WorldStatus;
  rememberedSummary: string;
  phase: string;
  gameTimeStamp: string;
};

export type CortexChoiceResult = {
  option: CortexOption;
  reasoning?: string;
  source: 'rule' | 'llm';
  llmDurationMs?: number;
  advancesSubgoalIdx?: number | null;
  completesSubgoal?: boolean | null;
};

export interface ChoicePicker {
  pickFeed(ctx: FeedContext): Promise<FeedChoiceResult | null>;
  pickWander(ctx: WanderContext): Promise<WanderChoiceResult | null>;
  // Optional — cortex skips utility AI entirely. RuleBased doesn't implement
  // it (returns undefined), LlmChoicePicker does. cortexDecide() falls back to
  // legacy decide() when picker has no cortex method.
  pickCortex?(ctx: CortexContext): Promise<CortexChoiceResult | null>;
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
    // Rule fallback never picks pre-emptive consume/maintenance options —
    // those are LLM-only. Threshold gates handle survival when LLM is down.
    const dirs = ctx.options.filter(
      (o) =>
        o.kind !== 'eat_berry_inv' &&
        o.kind !== 'eat_fruit_inv' &&
        o.kind !== 'drink_river' &&
        o.kind !== 'pee_now' &&
        o.kind !== 'warm_at_fire' &&
        o.kind !== 'pickup_wood' &&
        o.kind !== 'pickup_stone' &&
        o.kind !== 'sleep_now',
    );
    const unexplored = dirs.filter((o) => o.isUnexplored && o.kind !== 'stay');
    const pool = unexplored.length > 0 ? unexplored : dirs.filter((o) => o.kind !== 'stay');
    if (pool.length === 0) return { option: dirs[0] ?? ctx.options[0], source: 'rule' };
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

    const prompt = buildFeedPrompt(ctx.character, ctx.options, ctx.observations, ctx.rules, ctx.world);
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

    const prompt = buildWanderPrompt(ctx.character, ctx.options, ctx.rememberedSummary, ctx.world, ctx.observations);
    const res = await generate(this.ollama, prompt, { numPredict: 300, temperature: 0.7 });
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

  // Cortex pick — full-menu single LLM call. No rule fallback inside this
  // method; cortexDecide() handles the fallback ladder by re-routing through
  // legacy decide() when this returns null.
  async pickCortex(ctx: CortexContext): Promise<CortexChoiceResult | null> {
    if (ctx.options.length === 0) return null;
    const prompt = buildCortexPrompt(
      ctx.character,
      ctx.options,
      ctx.observations,
      ctx.rules,
      ctx.world,
      ctx.rememberedSummary,
      ctx.phase,
      ctx.gameTimeStamp,
    );
    // Cortex prompt is significantly larger than feed/wander (full action menu
    // + 30-deep observation log + lessons + goals) so qwen3:8b needs more
    // wall time. Bump timeout to 30s; the budget is intentional — cortex is
    // per-decide, and game-loop already serialises calls via decideInFlight.
    const res = await generate({ ...this.ollama, timeoutMs: 30_000 }, prompt, { numPredict: 300, temperature: 0.7 });
    if (!res.ok) {
      this.onLog(`[llm] cortex call failed (${res.kind}: ${res.error}) → idle (pure-LLM)`);
      return null;
    }
    const parsed = parseLlmResponse(res.text);
    if (!parsed) {
      this.onLog(`[llm] cortex unparseable: ${res.text.slice(0, 120)} → idle (pure-LLM)`);
      return null;
    }
    const match = ctx.options.find((o) => {
      if (o.kind !== parsed.choice) return false;
      if (parsed.target && o.target && parsed.target !== o.target) return false;
      return true;
    });
    if (!match) {
      this.onLog(`[llm] cortex picked invalid kind=${parsed.choice} target=${parsed.target ?? '-'} → idle (pure-LLM)`);
      return null;
    }
    this.onLog(`[llm] cortex pick=${match.kind}${match.target ? ' target=' + match.target : ''} (${res.totalDurationMs}ms) — ${parsed.reasoning}`);
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
