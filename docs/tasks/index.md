# Development Phases

Tiap phase adalah granular checklist yang bisa di-execute step-by-step. Session baru buka halaman phase aktif, eksekusi task, check off.

## Phase status

| Phase | Status | Notes |
|-------|--------|-------|
| [0 — Documentation](./phase-0-documentation) | ✅ Complete | VitePress + all spec docs (2026-04-23) |
| [1 — Foundation](./phase-1-foundation) | ✅ Complete | Scaffold + WS handshake + empty map + Docker Compose + DNS (2026-04-24) |
| [2 — Core Survival](./phase-2-survival) | ✅ Complete | Stats, forage, Utility AI, hysteresis triggers, rest, circadian (2026-04-25) |
| [3 — Hunting & Cooking](./phase-3-hunting) | ✅ Complete | Animals, hunt, fire cook, raw/cooked split (2026-04-25) |
| [4 — Learning Engine](./phase-4-learning) | ✅ Complete | LLM choice picker (qwen3:8b) + observation log + daily reflection cycle all shipped 2026-04-25. Rules persist as spirit memory; first verified rule "Rest is necessary for survival" (conf 0.90) was quoted by feed picker on next call. |
| [5 — Death & Spirit Memory](./phase-5-death) | 🟡 In progress | Natural death + lifespan + lineage events shipped (2026-04-25). Inherited rules pending Phase 4 reflection. |
| [6 — Polish](./phase-6-polish) | ⏳ Pending | Palette cycle, UI, sprite animations, production |
| [7 — Planning Layer](./phase-7-planning) | ⏳ Backlog | Micro-plan (2-3 step subgoal chains) over the per-tick decision loop. Spec drafted 2026-04-25, awaiting greenlight. |

## How to use these

Tiap task punya `[ ]` checkbox. Saat task selesai, Loodee ganti jadi `[x]` dan commit. Session baru buka halaman phase aktif, langsung tau next task apa.

Tasks di-ordered by dependency — gak boleh skip, tapi boleh batch eksekusi tiga-empat task di-satu session.
