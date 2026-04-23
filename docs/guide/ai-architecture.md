# AI Architecture

## Two-layer brain

Udu character punya **dua otak**:

1. **Utility AI** — reactive, real-time, instant. Bikin decision tiap tick.
2. **LLM Reflection Engine** — deliberative, slow, natural-language. Jalan tiap malam, generate rules.

Keduanya bekerja bareng: Utility AI **execute** decisions, Reflection Engine **shape** future decisions.

## Utility AI (real-time layer)

### Decision loop

Setiap **decision tick** (500ms - 2s):

1. Enumerate semua `available_actions` (depending on context: nearby resources, current inventory, current stats)
2. Untuk tiap action, compute `score = utility_function(action, state, rules)`
3. Pilih action dengan score tertinggi
4. Jalankan action (walking, eating, hunting, etc.)

### Utility function

```typescript
function score(action: Action, state: CharacterState, rules: Rule[]): number {
  let s = baseUtility(action)             // 0-50: default value of action
  s += urgencyModifier(action, state)     // -30 to +50: based on stat levels
  s += proximityModifier(action, state)   // -20 to +20: closer = better for "go" actions
  s += ruleModifier(action, rules)        // -100 to +100: learned rule impact
  s += randomNoise(-3, 3)                 // small stochastic element
  return s
}
```

### Stat urgency examples

| Stat | Value | Urgency for `drink` | Urgency for `sleep` |
|------|-------|----------------------|----------------------|
| thirst | 90 | 0 | 0 |
| thirst | 50 | +10 | 0 |
| thirst | 20 | +30 | 0 |
| thirst | 5 | +50 | 0 |
| energy | 20 | 0 | +30 |
| energy | 10 | 0 | +50 |

## Reflection Engine (deliberative layer)

### When it fires

- End of every game-day (24 min real)
- Also: on-demand via admin endpoint (buat testing)

### Input

Memory log hari itu — semua events yang happened, format:

```json
[
  {"t": "day3-08:00", "action": "walk_to", "target": "bush_A"},
  {"t": "day3-08:12", "action": "eat_berry", "source": "bush_A", "item": "berry_red"},
  {"t": "day3-10:00", "event": "stat_change", "stat": "sickness", "from": 0, "to": 30},
  {"t": "day3-14:00", "action": "drink", "source": "river_spot_3"},
  ...
]
```

### Prompt template

```
You are analyzing a day in the life of a primitive character in a survival game.
Below is the memory log from one game-day.

Character stats at start: hunger=60, thirst=70, energy=80, bladder=20
Character stats at end: hunger=40, thirst=55, energy=40, bladder=60

Memory log:
<LOG>

Task: Identify 1-5 actionable patterns that this character should learn from today.
For each pattern, output a JSON rule with:
- condition: when this rule applies (short natural language)
- effect: what weight modifier to apply to relevant actions
- confidence: 0.0 to 1.0 based on how strongly the data supports this

Output format (strict JSON, no prose):
{
  "rules": [
    {"condition": "...", "effect": "...", "confidence": 0.8},
    ...
  ]
}

/no_think
```

### Output handling

1. Parse JSON response (dengan fallback jika malformed)
2. Untuk tiap rule, generate deterministic `rule_id` (hash condition)
3. Check existing rule dengan ID sama:
   - Jika ada, update confidence (weighted average)
   - Jika baru, insert
4. Trigger utility function recompute pada next tick

### Rule decay

Rules yang **gak pernah triggered** dalam 7 game-days → confidence turun 10%.
Confidence < 0.1 → rule dihapus.

Ini bikin "myth" / outdated beliefs bisa hilang over time — realistic.

## Spirit Memory (cross-generation)

Saat karakter mati:
1. Record life event: `death_reason`, `lifespan_game_hours`, `final_rules_count`
2. Increment `lineage.iteration`
3. Karakter baru spawn dengan rules dari karakter sebelumnya **intact**
4. Rules tagged dengan `inherited: true` + `from_generation: N`
5. UI menampilkan "Iteration #N" + list inherited rules

### Future: Oral tradition decay (v2+)

Knowledge yang passed ke next gen bisa **di-mutate** atau **di-drop** dengan probability, simulating knowledge loss seperti di real tribes:
- 10% chance rule `confidence` turun saat transfer
- 2% chance condition-nya "garbled" (bahasa berubah sedikit)
- Bikin mythology emergent

## Why this works

- **Utility AI** adalah pasti, cepat, deterministik — cocok buat moment-to-moment
- **LLM** adalah fleksibel, bisa notice pattern, bisa ekspresikan dalam bahasa — cocok buat deliberation
- Kombinasinya = karakter **responsive** tapi juga **thoughtful**
- Lo sebagai observer bisa baca apa yang dia pelajarin — itu yang bikin menarik

## Trade-offs

| Aspect | Choice | Trade-off |
|--------|--------|-----------|
| LLM local vs cloud | Local (Ollama) | Gratis + no rate limit, tapi slower inference |
| Utility AI vs GOAP | Utility AI | Simpler to implement & tune, tapi gak bisa multi-step planning |
| Daily reflection vs hourly | Daily | Hemat LLM calls, tapi slower learning curve |
| Rules as weights vs rules as hard rules | Weights (scalar) | Fuzzy & overridable, tapi bisa conflict antar rules |
