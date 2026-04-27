import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { openDb } from './db.js';
import { GameLoop } from './game-loop.js';
import { CharacterRepo } from './character-repo.js';
import { ResourceRepo } from './resource-repo.js';
import { EventRepo } from './event-repo.js';
import { RuleRepo } from './rule-repo.js';
import { SpatialMemoryRepo } from './spatial-memory-repo.js';
import { ChunkVisitRepo } from './chunk-visit-repo.js';
import { DailyGoalRepo } from './daily-goal-repo.js';
import { NETWORK_CONFIG } from '../../shared/config.js';
import type { ClientMessage, ServerMessage } from '../../shared/types.js';

const PORT = Number.parseInt(process.env.PORT ?? String(NETWORK_CONFIG.backendPort), 10);

const db = openDb();
const repo = new CharacterRepo(db);
const resourceRepo = new ResourceRepo(db);
const eventRepo = new EventRepo(db);
const ruleRepo = new RuleRepo(db);
const spatialRepo = new SpatialMemoryRepo(db);
const chunkVisitRepo = new ChunkVisitRepo(db);
const dailyGoalRepo = new DailyGoalRepo(db);
const loop = new GameLoop(repo, resourceRepo, eventRepo, ruleRepo, spatialRepo, chunkVisitRepo, dailyGoalRepo);
loop.init();
const clients = new Set<WebSocket>();

const http = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === 'GET' && req.url === '/api/status') {
    const snap = loop.snapshot();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        uptime_ms: Math.floor(process.uptime() * 1000),
        clients: clients.size,
        current_iteration: snap.character?.iteration ?? 0,
        character_id: snap.character?.id ?? null,
        total_rules: 0,
        ollama_reachable: false,
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/api/admin/reflect-now') {
    // Force a reflection cycle without waiting for the next game-day boundary.
    // Useful for verifying the pipeline end-to-end during development.
    loop
      .triggerReflectionNow()
      .then((result) => {
        const status = result.ok ? 200 : 503;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/admin/rules') {
    const rs = ruleRepo.loadActive(loop.lineageIdForAdmin());
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ rules: rs }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/admin/daily-goal-now') {
    loop
      .triggerDailyGoalNow()
      .then((result) => {
        const status = result.ok ? 200 : 503;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      })
      .catch((err) => {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/admin/daily-goal') {
    const goal = loop.dailyGoalForAdmin();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ goal }));
    return;
  }
  if (req.method === 'GET' && req.url === '/api/admin/options') {
    const data = loop.debugOptions();
    res.writeHead(data ? 200 : 409, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data ?? { ok: false, error: 'no live character' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/admin/kill') {
    const ok = loop.kill('admin');
    res.writeHead(ok ? 200 : 409, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok, message: ok ? 'killed' : 'already dead or no character' }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/admin/set-stat') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}') as { stat?: string; value?: number };
        const stat = parsed.stat;
        const value = parsed.value;
        const valid = ['hunger', 'thirst', 'bladder', 'energy', 'sickness', 'health', 'temperature'];
        if (!stat || !valid.includes(stat) || typeof value !== 'number') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'expected {stat, value}', valid }));
          return;
        }
        const ok = loop.setStat(
          stat as 'hunger' | 'thirst' | 'bladder' | 'energy' | 'sickness' | 'health' | 'temperature',
          value,
        );
        res.writeHead(ok ? 200 : 409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok, stat, value }));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
      }
    });
    return;
  }
  if (req.method === 'POST' && req.url === '/api/admin/add-item') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 256) req.destroy(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}') as { item?: string; count?: number };
        const valid = ['berry', 'fruit', 'wood', 'branch', 'vine', 'stone', 'meat_raw', 'meat_cooked'];
        if (!parsed.item || !valid.includes(parsed.item)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'expected {item}', valid }));
          return;
        }
        const count = Math.min(parsed.count ?? 1, 20);
        for (let i = 0; i < count; i++) loop.addItem(parsed.item!);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, item: parsed.item, count }));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/admin/speed') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ multiplier: loop.getTimeMultiplier(), allowed: [1, 2, 3] }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/admin/speed') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 256) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}') as { multiplier?: number };
        const m = parsed.multiplier;
        if (m !== 1 && m !== 2 && m !== 3) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'multiplier must be 1, 2, or 3' }));
          return;
        }
        loop.setTimeMultiplier(m);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, multiplier: loop.getTimeMultiplier() }));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
      }
    });
    return;
  }
  if (req.method === 'GET' && req.url === '/api/admin/character') {
    // Compact character snapshot for observation tooling. Stats, position,
    // inventory, current action, life/daily-goal. NOT for frontend rendering
    // (that path uses WS state_update); intended for scripts/observe.py.
    const ch = loop.snapshot().character;
    if (!ch) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'no character' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: ch.id,
        iteration: ch.iteration,
        x: ch.position.x,
        y: ch.position.y,
        facing: ch.facing,
        stats: ch.stats,
        inventory: ch.inventory,
        currentAction: ch.currentAction.type,
        currentTarget: ch.currentAction.target ?? null,
        lifeGoal: ch.lifeGoal?.text ?? null,
        dailyGoalStep: ch.dailyGoal
          ? `${ch.dailyGoal.currentStepIdx}/${ch.dailyGoal.subGoals.length}`
          : null,
      }),
    );
    return;
  }
  if (req.method === 'GET' && req.url === '/api/admin/cortex') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ enabled: loop.getCortexEnabled() }));
    return;
  }
  if (req.method === 'POST' && req.url === '/api/admin/cortex') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 256) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}') as { enabled?: boolean };
        if (typeof parsed.enabled !== 'boolean') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'enabled must be boolean' }));
          return;
        }
        loop.setCortexEnabled(parsed.enabled);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, enabled: loop.getCortexEnabled() }));
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid json' }));
      }
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

const wss = new WebSocketServer({ server: http, path: NETWORK_CONFIG.wsPath });

wss.on('connection', (ws, req) => {
  clients.add(ws);
  console.log(`[ws] client connected (${req.socket.remoteAddress}); total=${clients.size}`);

  send(ws, { type: 'state_update', ...payloadFromState() });

  ws.on('message', (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === 'heartbeat') {
      send(ws, { type: 'pong' });
    } else if (msg.type === 'request_full_state') {
      send(ws, { type: 'state_update', ...payloadFromState() });
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[ws] client disconnected; total=${clients.size}`);
  });

  ws.on('error', (err) => {
    console.warn('[ws] error:', err);
  });
});

function payloadFromState() {
  const state = loop.snapshot();
  return {
    time: state.time,
    character: state.character,
    resources: state.resources,
    recentEvents: state.recentEvents,
    aiLog: state.aiLog,
    visibleTiles: state.visibleTiles,
    exploredTiles: state.exploredTiles,
  };
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMessage): void {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

loop.setLineageListener((e) => {
  if (e.event === 'death') {
    broadcast({
      type: 'lineage_event',
      event: 'death',
      deceasedCharacterId: e.deceasedCharacterId,
      reason: e.reason,
      lifespan: { gameHours: e.lifespanGameHours },
    });
  } else {
    broadcast({
      type: 'lineage_event',
      event: 'respawn',
      newIteration: e.newIteration,
    });
  }
});

let lastBroadcast = 0;
loop.start((state) => {
  const now = Date.now();
  if (now - lastBroadcast < NETWORK_CONFIG.stateBroadcastMs) return;
  lastBroadcast = now;
  broadcast({
    type: 'state_update',
    time: state.time,
    character: state.character,
    resources: state.resources,
    recentEvents: state.recentEvents,
    aiLog: state.aiLog,
    visibleTiles: state.visibleTiles,
    exploredTiles: state.exploredTiles,
  });
});

http.listen(PORT, () => {
  console.log(`[udu-backend] listening on :${PORT} (ws path ${NETWORK_CONFIG.wsPath})`);
});

const shutdown = (signal: string) => {
  console.log(`[udu-backend] ${signal} received, shutting down`);
  loop.stop();
  wss.close();
  http.close();
  db.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
