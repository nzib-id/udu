# Distribution Strategy

**Decision date:** 2026-04-25.
**Status:** Active. Revisit when content market test produces signal (positive or negative).

## TL;DR

Udu ships as **Archetype A — Aquarium Watcher** primary. Market test via Loodee content marketing. If signal weak, pivot ladder is **A → C → B**. Skip D entirely.

## Archetypes

Four player roles considered:

| Archetype | Role | Distance from current state |
|-----------|------|------------------------------|
| **A. Aquarium Watcher** | Passive observer. Watch AI char auto-survive, read reflection logs, see lineage memory accrue. | ~5% (basically already there) |
| **B. Tribal Steward** | Rimworld-style. Player sets high-level goals, AI tribe executes. Multi-char + social memory. | ~60% (multi-char architecture) |
| **C. Generational God** | Occasional intervention — whisper wisdom, place artifact, prune rules. Lineage-first narrative. | ~25% (intervention UI on top of existing rules + lineage) |
| **D. Active Survivor** | Manual control (WASD, click-to-act). | **Rejected** — conflicts with LLM-brain-as-protagonist vision. |

## Why A primary

1. **Closest to current state.** udu.loodee.art is already a de-facto aquarium. Shipping = polish + content.
2. **Zero-cost signal.** Loodee content marketing (clips, screenshots, "lineage day N" posts) tests A naturally. Watch counts, watch time, comment depth = validation.
3. **Avoids premature investment.** B and C add features that A doesn't need. Building them before signal = waste if A is the answer.

## Pivot ladder

If A market signal is weak:

1. **A → C** (~2–3 months). Cheapest pivot. Add intervention UI: whisper wisdom into LLM context, place artifact (sigil tile that biases reasoning), lineage tree viz. Existing lineage memory + reflection rules system reuses 90%.
2. **A → B** (~4–6 months). Heavier. Multi-char + tribe management UI + social memory + per-char relationship graph.
3. **Skip D.** Conflicts with vision.

## Dev priority — next 2–3 months

Deepen the aquarium. Every item below is valid in A and survives a pivot to C or B (universal foundation).

- **Action repertoire** — fireplace fuel, temperature (Module 1 WIP), cook variations, craft, build.
- **Lineage display polish** — lineage tree UI, ancestor wisdom timeline, "Generation N has passed" banner.
- **Reasoning text quality** — cinematic LLM output, less generic phrasing, prompt iteration.
- **World variety** — weather, season, biome edges, day/night already shipped.
- **Visual polish** — sprite animation, time-of-day overlays, particles, ambient SFX.

## What NOT to invest in (yet)

Archetype-specific features that risk being throwaway if pivot doesn't fire:

- **Multi-char tribal architecture** — B-only.
- **Player input controls** — WASD, click-to-move — D-only (dropped archetype).
- **Complex management UI** — task queues, priority sliders — B-only.
- **Native packaging** — Tauri, Steam prep, code signing — premature, post-validation.

## Decision filter for new features

For every new mechanic, ask: **"Is this valid in A, C, AND B?"**

- **Yes** → prioritize.
- **Only A** → ship if it polishes the aquarium experience.
- **Only B or C** → postpone until that archetype is the validated direction.

## What counts as "market signal"

Defined ahead so the trigger isn't gut-feel:

- **Positive (stay on A):** content engagement growing month-over-month — watch time, returning viewers, organic reshares. Ad-hoc lineage-day clips drive replies, not flat-line scrolls.
- **Weak (start C planning):** content publishes, view counts plateau, comments are generic ("cool"), no organic shares.
- **Negative (consider C/B):** content fails to land across multiple platforms × multiple framings. Audience clearly wants agency, not observation.

Concrete metric thresholds TBD — first 2–3 months of Loodee content gives the baseline.

## Why this matters

Without this filter, Loodee risks building "interesting features" that don't serve distribution. Distribution-as-goal = every feature must serve a **player**, not creator personal taste. Market test via content = de-risk a 12–18 month investment in the wrong direction.

## Memory pointer

Memory entry: `~/.claude/projects/-home-nzib--openclaw-workspace/memory/project_udu_distribution_strategy.md` — same content, kept in sync.
