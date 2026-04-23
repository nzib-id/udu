# Phase 4 — Learning Engine

**Goal:** LLM reflection bikin karakter belajar dari pengalaman harian. Rules ter-generate, di-merge ke utility weights, karakter **perubahan perilakunya terobservasi**.

**Estimate:** ~3-4 hours (prompt engineering butuh iterasi)

**Prerequisites:** Phase 3 complete

## Tasks

### Event log enrichment

- [ ] Ensure `event` table captures semua yang relevant:
  - action_start, action_end
  - stat_change (before → after, cause)
  - resource interaction (which bush, which berry color, etc.)
  - death, spawn
- [ ] Add metadata variety: colors, locations, time-of-day for each action

### Reflection trigger

- [ ] Detect end-of-game-day boundary (currentHour rolls over to dawn=05:00)
- [ ] On trigger: collect all events from prev 24 game-hours
- [ ] Enqueue reflection job (single concurrency, pakai simple in-memory queue)

### Ollama integration

- [ ] Backend module `backend/src/llm/ollama.ts`
- [ ] Config: `OLLAMA_URL`, `OLLAMA_MODEL` from env
- [ ] Call `POST /api/generate` with prompt
- [ ] Timeout: 30 seconds (fallback: skip reflection that day)
- [ ] Connection retry: 2 attempts, then skip

### Prompt engineering

- [ ] Initial prompt template (lihat `/guide/ai-architecture` — refine iteratively)
- [ ] Include: current stats, memory log, trailing `/no_think`
- [ ] Expected output: strict JSON `{rules: [...]}`
- [ ] Test with 3-5 different synthetic logs, verify parse-able output
- [ ] Fix prompt until >90% responses parse cleanly

### Rule parsing & storage

- [ ] Parse LLM response → validate schema → extract rules array
- [ ] For each rule: generate deterministic hash ID from condition
- [ ] Upsert into `rule` table
  - if existing: weighted-avg confidence update
  - if new: insert with source iteration
- [ ] Save full reflection record to `reflection` table (audit trail)

### Rule → utility integration

- [ ] Rules include `affected_actions` + `weight_delta`
- [ ] At decision time, untuk tiap candidate action:
  - find matching rules
  - sum weight_delta × confidence
  - add to score
- [ ] Rules applied to action id + context (e.g. "eat_berry at bush_A" targets bush_A specifically)

### Rule decay

- [ ] Cron in game-loop: tiap game-day check rules not triggered in 7 days
- [ ] Reduce confidence by 10%
- [ ] If confidence < 0.1, delete rule
- [ ] Log decay events to `event` table

### Trigger event flow visualization

- [ ] Frontend receive `reflection_complete` WebSocket message
- [ ] UI shows temporary banner: "Day N reflection — N new rules"
- [ ] Reflection log panel updated dengan list new/updated rules

### Admin debug

- [ ] `POST /api/admin/trigger_reflection` — force reflection NOW (useful untuk testing)
- [ ] `GET /api/reflections` — history of past reflections with raw LLM output (debug)
- [ ] `GET /api/rules` — current ruleset with confidence

### Verify

- [ ] First reflection fires after 24 min of gameplay (or via admin trigger)
- [ ] At least 1 rule extracted per day (with reasonable synthetic log)
- [ ] Karakter behavior VISIBLY CHANGES after rules applied (e.g. avoid previously-consumed-then-sick bush)
- [ ] Rule decay works over multiple game-days
- [ ] Ollama call failures handled gracefully (skip, log, continue)
