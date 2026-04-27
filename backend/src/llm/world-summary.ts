// Aggregate "what this character knows about the world" for the life-goal LLM
// call. Output has two faces: a structured set of allowed entities (used to
// validate the LLM's referenced_entities — anything outside this set is
// hallucinated and rejects the goal) and a human-readable text block that goes
// into the prompt. Keep counts > names; we want the model to set goals like
// "find more water" or "explore north", not "go to bush_1234".

import type { RememberedResource } from '../spatial-memory-repo.js';
import type { ChunkVisit } from '../chunk-visit-repo.js';
import { chunkGridDims } from '../../../shared/spatial.js';
import type { Character, ResourceType } from '../../../shared/types.js';
import type { EventRepo } from '../event-repo.js';
import type { CharacterRepo, LineageTrajectoryRow } from '../character-repo.js';

export type WorldSummary = {
  text: string;
  allowedEntities: Set<string>;
};

export function buildWorldSummary(
  character: Character,
  knownResources: RememberedResource[],
  chunkVisits: ChunkVisit[],
  eventRepo: EventRepo,
  cachedRules: string[],
): WorldSummary {
  const byType: Partial<Record<ResourceType, number>> = {};
  for (const r of knownResources) byType[r.type] = (byType[r.type] ?? 0) + 1;

  const { cols, rows } = chunkGridDims();
  const total = cols * rows;
  const visited = chunkVisits.length;

  const pastDeaths = loadRecentDeathReasons(eventRepo, 5);

  const allowed = new Set<string>();
  for (const t of Object.keys(byType)) allowed.add(t);
  if (visited > 0) allowed.add('explored_area');
  if (visited < total) allowed.add('unexplored_area');
  for (const d of pastDeaths) allowed.add(`death_${d}`);
  for (const item of new Set(character.inventory)) allowed.add(item);
  if (cachedRules.length > 0) allowed.add('lessons');

  const knownLine = Object.keys(byType).length === 0
    ? '- known resources: none yet'
    : `- known resources: ${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', ')}`;
  const exploredLine = `- explored ${visited}/${total} regions of the map`;
  const inventoryLine = `- inventory: ${character.inventory.length === 0 ? 'empty' : Array.from(new Set(character.inventory)).join(', ')}`;
  const deathLine = pastDeaths.length === 0
    ? '- no past deaths in this lineage'
    : `- past deaths in this lineage: ${pastDeaths.join(', ')}`;
  const lessonLine = cachedRules.length === 0
    ? ''
    : `\nLessons inherited from past lives:\n${cachedRules.map((r) => `- ${r}`).join('\n')}`;

  const text = [
    `- iteration: ${character.iteration}`,
    knownLine,
    exploredLine,
    inventoryLine,
    deathLine,
  ].join('\n') + lessonLine;

  return { text, allowedEntities: allowed };
}

// Lineage trajectory for diagnose+prescribe pattern in life-goal generation.
// Each row = one past generation in this lineage with the goal it pursued and
// what it actually accomplished by the time it died. The next gen reads this
// to spot recurring failure patterns ("3 gens died of thirst at <2 chunks") and
// pick a goal that addresses the bottleneck rather than rephrasing the same
// aspiration. Returns empty array if first life or no past deaths.
export function buildLineageTrajectoryText(
  characterRepo: CharacterRepo,
  lineageId: number,
  limit: number,
): string {
  const rows: LineageTrajectoryRow[] = characterRepo.loadLineageTrajectory(lineageId, limit);
  if (rows.length === 0) return '';
  const lines = rows.map((r) => {
    const goal = r.goalText ? `"${r.goalText}"` : '(no life goal)';
    const days = r.daysLived.toFixed(1);
    const chunks = r.chunksVisited;
    const resources = r.resourcesDiscovered;
    const death = r.deathReason ?? 'unknown cause';
    return `- Gen ${r.iteration}: pursued ${goal} → lived ${days} days, visited ${chunks} chunks, discovered ${resources} resources, died of ${death}`;
  });
  return `Past lineage history (most recent first):\n${lines.join('\n')}`;
}

function loadRecentDeathReasons(eventRepo: EventRepo, limit: number): string[] {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const events = eventRepo.loadSince(since, 200);
  const reasons: string[] = [];
  for (const e of events) {
    if (e.event_type !== 'death') continue;
    try {
      const p = JSON.parse(e.payload) as { reason?: string };
      if (typeof p.reason === 'string') reasons.push(p.reason);
    } catch {
      /* ignore */
    }
  }
  return reasons.slice(-limit);
}
