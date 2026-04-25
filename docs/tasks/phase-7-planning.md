# Phase 7 — Planning Layer (Backlog)

**Status:** ⏳ Backlog (proposed 2026-04-25, awaiting Nzib green light)

**Goal:** Add a thin micro-planning layer on top of the per-tick decision loop so the character can chain 2-3 step subgoals (e.g. `shake_tree → pickup_fruit_ground → eat_fruit_inv`, or `pickup_wood → cook_meat → eat_meat_cooked`) without re-deciding from scratch every tick. Survival thresholds always override the plan — comfort/efficiency don't trump the rules of nature.

**Scope choice:** **micro-plan, not macro-plan.** Plans are 2-3 step subgoal chains that match a single visible sequence, not multi-day stockpile strategies. This nets the user-visible win (no more shake-spam without pickup, smoother cook flow) without opening the door to plan staleness.

**Estimate:** ~2-3 hours (one focused session) once design is locked.

**Prerequisites:**
- Phase 4 complete (LLM choice picker + observation log + reflection — DONE 2026-04-25)
- Phase 5 Option A complete (death + lifespan — DONE 2026-04-25)

## Design proposal

### Data model

```ts
// New types in shared or backend/src/llm/plan.ts
export type PlannedStep = { kind: FeedKind; target?: string };

export type Plan = {
  goal: string;            // free-text from LLM, e.g. "cook the raw meat"
  steps: PlannedStep[];    // 1..3 steps, ordered
  createdAt: number;       // real ms
  expiresAtMs: number;     // createdAt + 30 game-min worth of real ms
  source: 'llm' | 'rule';
};
```

`GameLoop` holds at most one active plan at a time: `private currentPlan: Plan | null = null`.

### Decision flow

```
advanceAI tick:
  if currentPlan !== null:
    if expired or step[0] unreachable or stat threshold fired with mismatch:
      currentPlan = null  → fall through to LLM decide
    else:
      execute step[0] (same path as today's single-action decide)
      on completion: shift step[0] off; if steps empty → currentPlan = null
  else:
    call LLM planner (new prompt) OR fallback to existing single-action decide
```

The existing single-action `LlmChoicePicker.pickFeed` becomes the fallback path when planning fails or returns invalid.

### LLM prompt

New file `backend/src/llm/prompt-plan.ts`. Same context as feed prompt (stats, options, observations, rules) but asks for a sequence:

```json
{
  "goal": "cook the raw meat I'm holding",
  "plan": [
    {"kind": "pickup_wood", "target": ""},
    {"kind": "cook_meat", "target": "fire_1"},
    {"kind": "eat_meat_cooked", "target": ""}
  ],
  "reasoning": "I have raw meat but no fire fuel; gather wood first."
}
```

System block additions: "Each step must be reachable from where you'll be after the previous step. The final step must restore the stat that's currently low. Maximum 3 steps."

### Invalidation rules

Plan is dropped (and re-decided) when:

1. **Stat threshold fires that mismatches the plan's goal.** Plan goal is `cook the raw meat` (hunger goal), but `thirst <= 25` triggers mid-plan → drop, re-decide for thirst.
2. **Step target disappears.** Tree was shaken empty between plan creation and execution; chicken fled; fire went out. Reachability re-checked per tick.
3. **Plan expired.** `Date.now() > expiresAtMs`. 30 game-min ≈ 30 real-sec by current time scale, so plans are short-lived intent, not commitments.
4. **Step path can't be built.** A* fails → drop plan.

### Observation recording

Each executed step gets recorded in the same `Observation` ring buffer used by Phase 4. Plan execution is invisible to the rest of the system — it just happens to produce the same sequence of `executeFinal` calls a single-action LLM would have, just without a round-trip per step.

### Fallback strategy

- LLM plan call fails (timeout/parse/invalid step) → fall back to `LlmChoicePicker.pickFeed` (existing single-action). No regression.
- LLM plan returns 1-step plan → fine, treat as a single action.
- LLM plan step kind doesn't match any reachable option → drop plan, single-action fallback.

### What is NOT changing

- Threshold logic in `ai.decide` ("rules of nature") still gates everything. Plan can't override survival.
- Reflection layer keeps running; learned rules get injected into both plan-prompt and fallback feed-prompt.
- Single-action decide path stays as the last-resort safety net.

## Tasks (when greenlit)

### Backend — types + planner

- [ ] Create `backend/src/llm/plan.ts` with `Plan`/`PlannedStep` types
- [ ] Create `backend/src/llm/prompt-plan.ts` mirroring `prompt-feed.ts` shape but emitting plan JSON schema
- [ ] Create `backend/src/llm/plan-picker.ts` — `LlmPlanPicker` that calls Ollama, validates each step against current options, returns `Plan | null`
- [ ] Add invalidation helpers: `isStepReachable(step, options)`, `isPlanExpired(plan)`, `planMatchesUrgency(plan, urgentStat)`

### Backend — wiring

- [ ] `GameLoop.currentPlan: Plan | null` field
- [ ] `advanceAI` plan-first path: execute next step if plan valid, else call planner, else fall back to existing decide
- [ ] Drop-and-re-decide on threshold mismatch / unreachable step / expiry
- [ ] Append each executed step to observations (no special handling — same recorder)
- [ ] Reset plan on respawn / kill

### Tunables in `shared/config.ts`

- [ ] `PLAN_CONFIG.maxSteps = 3`
- [ ] `PLAN_CONFIG.expirationGameMin = 30`
- [ ] `PLAN_CONFIG.minStatGapForPlan = 10` — only plan when slack from threshold (don't plan when starving)

### Telemetry / debug

- [ ] Log `[plan] new goal="..." steps=[a,b,c] (Xms)` on creation
- [ ] Log `[plan] step k=X done, advancing` per step
- [ ] Log `[plan] dropped: <reason>` on invalidation
- [ ] Broadcast `Character.activePlan` so HUD can render the chain (optional but cool)

### Frontend (optional)

- [ ] HUD chip showing current plan: "📋 cook the raw meat (2/3)" — italic gray under reasoning chip
- [ ] Strike out completed steps as plan progresses

### Verify

- [ ] Force `hunger=20` with raw meat in inventory → expect plan `[pickup_wood, cook_meat, eat_meat_cooked]` (or `[cook_meat, eat_meat_cooked]` if wood already on hand)
- [ ] Force `thirst=15` mid-plan → expect plan dropped, character heads to water
- [ ] Force `target tree` to be empty between plan creation + step exec → expect plan dropped, single-action fallback fires
- [ ] Verify observation log captures each step (not just the last one)
- [ ] Verify rules from reflection get injected into plan prompt (look at the prompt log for "Lessons from past lives" block)

## Open questions for Nzib

- **Plan visible to player?** Phase 4 made reasoning visible via the HUD chip. Should the plan be visible too — does seeing "📋 cook the raw meat (1/3)" add to the experience or clutter the screen?
- **Hunt as a plan?** Hunt today is a single `executeFinal` call that resolves into chase + kill. Should hunt be modeled as a 2-step plan (`approach → swing`), or stay atomic? Atomic is simpler; 2-step makes the chase visible to the canopy-wiggle-style tween work that's already pending.
- **Plan survives partial state changes?** If the character takes damage (Phase 6 sickness escalation?) mid-plan, should the plan be invalidated even when no threshold fires? Conservative: yes, any "world changed materially" triggers re-decide.

## Lessons we already know going in

- **Plans go stale fast in this world.** A* paths can break, targets disappear, stats shift. Conservative invalidation > optimistic execution. When in doubt, re-decide.
- **Short plans > long plans.** 3 steps is enough to model "shake → pickup → eat" or "wood → cook → eat". 5+ steps would need a re-planning layer of its own.
- **Plans are about saving LLM calls and making sequences visible, not about strategy.** Strategy lives in the rules emitted by the reflection layer.
