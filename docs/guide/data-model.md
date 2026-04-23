# Data Model

SQLite database di `data/udu.db`. Akses via `better-sqlite3` (sync API, cocok buat game loop).

## Schema

### `character`
Current state karakter yang lagi hidup.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| lineage_id | INTEGER | FK → lineage.id |
| iteration | INTEGER | Generation number |
| spawn_time | INTEGER | Unix ms |
| x | REAL | Current position |
| y | REAL | Current position |
| hunger | REAL | 0-100 |
| thirst | REAL | 0-100 |
| bladder | REAL | 0-100 |
| energy | REAL | 0-100 |
| sickness | REAL | 0-100 (MVP optional, v1.5 critical) |
| inventory | TEXT | JSON array of items |
| current_action | TEXT | JSON {type, target, startedAt} |
| is_alive | INTEGER | 1/0 |

Ada **max 1 row aktif** (is_alive = 1) di MVP.

### `lineage`
Track generation history (spirit memory).

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| started_at | INTEGER | First character's spawn time |
| current_iteration | INTEGER | Latest iteration number |

Single row for MVP (1 lineage). v2 tribe mode = multiple lineages.

### `rule`
Learned rules (spirit memory content).

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | Deterministic hash of condition |
| lineage_id | INTEGER | FK → lineage |
| condition | TEXT | Natural language |
| effect | TEXT | Natural language (akan di-parse ke weight) |
| weight_delta | REAL | Numeric effect on utility score |
| affected_actions | TEXT | JSON array of action IDs this rule applies to |
| confidence | REAL | 0.0-1.0 |
| inherited_from_generation | INTEGER | NULL if created by current gen |
| created_at | INTEGER | Unix ms |
| last_triggered_at | INTEGER | For decay tracking |
| times_triggered | INTEGER | Counter |

### `event`
Memory log — everything that happens.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | Auto-increment |
| character_id | INTEGER | FK → character |
| game_time | TEXT | `dayN-HH:MM` format |
| real_time | INTEGER | Unix ms |
| event_type | TEXT | e.g. `action_start`, `action_end`, `stat_change`, `death`, `spawn` |
| payload | TEXT | JSON (details varies by event_type) |

Index: `(character_id, real_time)` untuk query cepet ambil log hari itu.

### `resource_state`
Current state of each resource di map.

| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | e.g. `bush_A`, `tree_3`, `river_spot_1` |
| type | TEXT | `bush`, `tree`, `river`, `fire`, `wood`, `animal_chicken`, `animal_fish` |
| x | REAL | Position |
| y | REAL | Position |
| state | TEXT | JSON, varies per type (e.g. `{berries: 3, regen_at: 12345}`) |

Seeded on first boot from map config, updated live saat karakter interact.

### `reflection`
Historical LLM reflection records — buat audit & display di UI.

| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK | |
| character_id | INTEGER | FK → character |
| game_day | INTEGER | Day number (1, 2, 3, ...) |
| real_time | INTEGER | Unix ms |
| input_log | TEXT | JSON of events fed to LLM |
| raw_output | TEXT | LLM response verbatim |
| parsed_rules | TEXT | JSON of rules extracted |
| duration_ms | INTEGER | LLM call duration |

## TypeScript types

Shared between frontend & backend di `/shared/types.ts`:

```typescript
export type Stats = {
  hunger: number
  thirst: number
  bladder: number
  energy: number
  sickness?: number
}

export type Position = { x: number; y: number }

export type ActionType =
  | 'idle'
  | 'walk_to'
  | 'eat_berry' | 'eat_fruit'
  | 'drink'
  | 'pickup_wood'
  | 'hunt' | 'eat_meat' | 'cook_meat'
  | 'defecate' | 'sleep' | 'wander'

export type Action = {
  type: ActionType
  target?: string         // resource ID
  startedAt: number       // Unix ms
  durationMs?: number     // estimated duration
}

export type Character = {
  id: number
  iteration: number
  position: Position
  stats: Stats
  inventory: string[]     // item IDs
  currentAction: Action
  isAlive: boolean
}

export type Rule = {
  id: string
  condition: string
  effect: string
  weightDelta: number
  affectedActions: ActionType[]
  confidence: number
  inheritedFromGeneration: number | null
  timesTriggered: number
}

export type GameState = {
  time: { day: number; hour: number; minute: number }
  character: Character
  resources: Resource[]
  rules: Rule[]
  recentEvents: Event[]   // last 20 for UI display
}
```

## File layout

```
projects/udu/
├── data/
│   ├── udu.db               # SQLite DB (gitignored)
│   └── migrations/
│       └── 001_initial.sql  # schema DDL
```

## Migrations

Lightweight — manual SQL files in `data/migrations/`. Diaplikasiin via script on boot:
- Check `PRAGMA user_version`
- Apply migrations with version > current
- Update version

No ORM. Raw SQL + prepared statements (better-sqlite3).
