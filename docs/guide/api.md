# API Protocol

Frontend connects to backend via WebSocket. Minimal REST untuk admin endpoints.

## WebSocket

### Endpoint

`wss://udu.loodee.art/ws`

(development: `ws://localhost:4247/ws`)

### Protocol

JSON messages. Server-initiated push + client request-response.

### Server → Client messages

#### `state_update`
Full state push, ~500ms cadence.

```json
{
  "type": "state_update",
  "time": { "day": 3, "hour": 14, "minute": 30 },
  "character": {
    "id": 42,
    "iteration": 3,
    "position": { "x": 120, "y": 340 },
    "stats": { "hunger": 65, "thirst": 40, "bladder": 20, "energy": 80 },
    "inventory": ["wood"],
    "currentAction": { "type": "walk_to", "target": "bush_A", "startedAt": 1234567890 },
    "isAlive": true
  },
  "resources": [
    { "id": "bush_A", "type": "bush", "x": 150, "y": 350, "state": { "berries": 3 } },
    ...
  ],
  "recentEvents": [
    { "id": 1234, "gameTime": "day3-14:20", "eventType": "action_start", "payload": {...} },
    ...
  ]
}
```

#### `delta_update` (optional optimization)
Patch-only untuk efficiency setelah initial full push.

```json
{
  "type": "delta_update",
  "changes": {
    "character.stats.hunger": 63,
    "character.position": { "x": 122, "y": 342 }
  }
}
```

#### `reflection_complete`
Fires saat reflection engine selesai generate rules baru.

```json
{
  "type": "reflection_complete",
  "gameDay": 3,
  "newRules": [
    { "id": "hash123", "condition": "eat berry_red at bush_A", "effect": "...", "confidence": 0.8 }
  ],
  "durationMs": 3200
}
```

#### `lineage_event`
Fires saat death / respawn.

```json
{
  "type": "lineage_event",
  "event": "death",
  "deceasedCharacterId": 42,
  "reason": "starvation",
  "lifespan": { "gameHours": 72 },
  "newIteration": 4
}
```

### Client → Server messages

MVP: read-only view, client gak kirim apa-apa kecuali heartbeat.

#### `heartbeat`
Keep-alive. Server replies dengan `pong`.

```json
{ "type": "heartbeat" }
```

#### `request_full_state`
Untuk re-sync setelah reconnect.

```json
{ "type": "request_full_state" }
```

## HTTP REST (admin & debug)

Base URL: `https://udu.loodee.art/api`

### `GET /api/status`
Health check.

```json
{
  "status": "ok",
  "uptime_ms": 123456789,
  "current_iteration": 3,
  "total_rules": 17,
  "ollama_reachable": true
}
```

### `GET /api/rules`
Current ruleset.

```json
{
  "rules": [
    { "id": "...", "condition": "...", "confidence": 0.8, ... }
  ]
}
```

### `GET /api/events?limit=100&since=<unix_ms>`
Event log query (debug).

### `GET /api/reflections?limit=20`
Historical reflection records.

### `POST /api/admin/trigger_reflection` (dev only)
Force reflection NOW (instead of waiting for game-day end).

```
Content-Type: application/json
Body: {}
Response: reflection result
```

### `POST /api/admin/reset` (dev only)
Kill current character, wipe lineage, restart fresh.

### `POST /api/admin/kill` (dev only)
Kill current character immediately (triggers respawn with memory).

## Rate limiting

- WebSocket state pushes: throttled to max 2/sec (500ms interval)
- Admin endpoints: no rate limit (localhost/dev use only)
- Ollama calls from backend: 1 in-flight max (queue if needed)

## Reconnect strategy

Frontend:
1. Auto-reconnect exponential backoff (1s, 2s, 4s, max 30s)
2. On reconnect, send `request_full_state`
3. Display "reconnecting..." banner during downtime
