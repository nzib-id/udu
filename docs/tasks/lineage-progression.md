# Lineage Progression via Reflective Insight

**Status:** IMPLEMENTED 2026-04-26 — typecheck clean, awaiting live test.

**Scope:** Standalone work, NOT part of Batch 7 cortex/reflection patches (those touch `prompt-cortex.ts` / `prompt-reflection.ts`; this touches `prompt-life-goal.ts`).

**Goal:** Gen baru ga ulang kesalahan gen lama. Baca death-context lineage → diagnose pattern → pilih life goal yang address bottleneck.

Contoh yang Nzib ekspektasi:

```
Gen 1: life goal "explore unexplored area"
       → explored 50%, mati karena thirst
       → reflection generate lessons

Gen 2: spawn, baca lessons + tau gen 1 mati di 50% karena thirst
       → mikir strategis: "harus survive dulu sebelum explore"
       → life goal BEDA: "must survive longer" (atau lebih konkret)
```

## Approach: Cara A (ACTIVE)

**Single LLM call, restructured prompt — diagnose + prescribe pattern.**

Output schema tambah field `diagnosis`:

```json
{
  "diagnosis": "Past 3 gens died trying to explore without securing water — survival is the bottleneck",
  "goal": "Master finding and remembering water sources before traveling far",
  "reason": "...",
  "priority": ...,
  "referenced_entities": [...]
}
```

### 3 Building Blocks

1. **Death-context capture** — saat char mati, save progress % terhadap life goal (selain cause-of-death yang udah ada).
2. **Lineage trajectory summary** — sebelum life-goal LLM call, build stringified history past N gens (goal pursued → progress % → cause of death).
3. **Prompt restructure** — paksa LLM mikir 2 langkah dalam 1 call:
   - Step 1 — Diagnose: "given lineage history, what's the recurring problem?"
   - Step 2 — Prescribe: "pick a goal that addresses that problem"
   - Constraint: "if lineage repeatedly failed at same goal, your goal MUST be different in nature, not just rewording"

## Parking lot: Cara B (DEFERRED)

**Two LLM calls — separation of concerns.**

- Call 1: Strategic reflection LLM — "given lineage history, what's the strategic insight?"
- Call 2: Life-goal LLM — given strategic insight, pick goal.

**Pros:** Cleaner separation, deeper reasoning per step.
**Cons:** 2× LLM call (+~30s spawn delay), Qwen3 8B inkonsisten — hasil belum tentu lebih bagus.

**When to escalate from A to B:** Kalau Cara A leak (LLM ngabaikan diagnosis, pilih goal yang ga address pattern, atau diagnosis-nya generic ga grounded).

## Implementation (Cara A)

**Migration 010** — `data/migrations/010_lineage_diagnosis.sql`:
- `character.life_goal_diagnosis TEXT`
- `character.chunks_visited_at_death INTEGER`
- `character.resources_discovered_at_death INTEGER`

**Files changed:**
- `shared/types.ts` — `LifeGoal.diagnosis?: string | null`
- `backend/src/character-repo.ts` — `recordDeath()` extended (chunks/resources counts), persist/rowToCharacter handle diagnosis, new `loadLineageTrajectory(lineageId, limit)`
- `backend/src/game-loop.ts` — `triggerDeath` snapshots `chunkVisits.size` & `knownResources.size` before clear; spawn flow passes `characterRepo` + `lineageId`; pushLog/logEvent include diagnosis
- `backend/src/llm/world-summary.ts` — new `buildLineageTrajectoryText()`
- `backend/src/llm/life-goal.ts` — calls trajectory builder, `numPredict 180→280`, parser requires `diagnosis` non-empty
- `backend/src/llm/prompt-life-goal.ts` — restructured to 2-step diagnose+prescribe; constraint "if 2+ gens died similar goals, MUST address different bottleneck"

**Verify on live test:**
- Boot: migration 010 applies, server runs.
- Gen 1 spawn: prompt shows `(This is the first life in this lineage — no trajectory yet.)`; LLM returns `diagnosis` field non-empty.
- Gen 2+ spawn: prompt shows `Past lineage history: Gen N: pursued "..." → lived X days, visited Y chunks, discovered Z resources, died of <reason>`; diagnosis references prior pattern; goal addresses the bottleneck.
