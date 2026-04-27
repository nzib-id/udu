export type Stats = {
  hunger: number;
  thirst: number;
  bladder: number;
  energy: number;
  sickness?: number;
  // HP — central death funnel. Drives at 0 drain HP at distinct rates,
  // sickness ≥80 drains HP, regen when thriving (all drives satisfied + low
  // sickness + awake). Death = HP=0. Reserved for future damage sources.
  health: number;
  // Body temperature (°C). Drifts toward phase ambient (or fire override
  // when near lit fire). Out-of-comfort tiers drain drives indirectly →
  // HP via existing drain rules. See TEMPERATURE_CONFIG.
  temperature: number;
};

export type Position = { x: number; y: number };

export type ActionType =
  | 'idle'
  | 'walk_to'
  | 'shake'
  | 'pickup'
  | 'eat'
  | 'drink'
  | 'hunt'
  | 'cook'
  | 'defecate'
  | 'sleep'
  | 'rest'
  | 'wander'
  | 'add_fuel'
  | 'drop';

export type Action = {
  type: ActionType;
  target?: string;
  startedAt: number;
  durationMs?: number;
};

export type Character = {
  id: number;
  iteration: number;
  spawnedAt: number;
  position: Position;
  stats: Stats;
  inventory: string[];
  currentAction: Action;
  isAlive: boolean;
  // Last LLM-driven choice annotation (only set when UDU_AI_MODE=llm and call
  // succeeded). lastChoice = the kind picked, lastReasoning = English narration
  // from the model. Used by the dev panel to surface "what is the char thinking".
  lastChoice?: string;
  lastReasoning?: string;
  lastChoiceAt?: number;
  // Facing direction in radians (atan2 convention: 0 = +x East, π/2 = +y South).
  // Updated each tick during movement. Drives the vision cone — tiles outside
  // the forward FoV are not added to spatial memory. In-memory only; server
  // restart re-anchors to the last walked direction or default 0 (East).
  facing: number;
  // Life goal — set once on spawn via LLM grounded in world summary. Drives
  // long-horizon prefs in wander/feed prompts. Revisable on reflection cycle.
  // Null until generation completes (or if LLM unavailable / validation failed).
  lifeGoal?: LifeGoal | null;
  // Daily goal — short-horizon plan generated once per game-day, breaks the
  // life goal into 2-4 sequential sub-goals. Null between rollover and the
  // LLM call resolving, or when survival_override etc. fails validation.
  dailyGoal?: DailyGoal | null;
};

export type LifeGoal = {
  text: string;
  reason: string;
  priority: number;
  setAtDay: number;
  // Diagnose+prescribe pattern: the strategic insight the LLM produced about
  // recurring lineage failures at the moment this goal was picked. Stored for
  // trace/debug; NOT shown to next gen (next gen diagnoses fresh).
  diagnosis?: string | null;
};

export type Alignment = 'advances' | 'maintains' | 'survival_override';

// Optional structured acceptance criteria. When set, server auto-advances the
// sub-goal as soon as the matching world signal fires — no LLM round-trip
// needed. Sub-goals that don't fit any of these shapes leave `check` undefined
// and rely on the LLM self-tag path (completes_subgoal in the choice picker).
export type SubGoalCheck =
  | { type: 'action_performed'; value: string }
  | { type: 'inventory_has'; item: string }
  | { type: 'chunk_visited_new' };

export type SubGoal = {
  text: string;
  successCriteria: string;
  completed: boolean;
  check?: SubGoalCheck;
};

export type DailyGoal = {
  id: number;
  day: number;
  summary: string;
  reason: string;
  alignment: Alignment;
  subGoals: SubGoal[];
  currentStepIdx: number;
  status: 'in_progress' | 'completed' | 'abandoned';
};

export type ResourceType =
  | 'bush'
  | 'tree_fruit'
  | 'tree_vine'
  | 'tree_wood'
  | 'river'
  | 'fire'
  | 'wood'
  | 'boulder'
  | 'branch'
  | 'vine'
  | 'fruit'
  | 'stone'
  | 'animal_chicken'
  | 'animal_fish';

export type Resource = {
  id: string;
  type: ResourceType;
  x: number;
  y: number;
  state: Record<string, unknown>;
};

export type Rule = {
  id: string;
  condition: string;
  effect: string;
  weightDelta: number;
  affectedActions: ActionType[];
  confidence: number;
  inheritedFromGeneration: number | null;
  timesTriggered: number;
};

export type GameEvent = {
  id: number;
  gameTime: string;
  eventType: string;
  payload: Record<string, unknown>;
};

export type GameTime = { day: number; hour: number; minute: number };

export type AiLogKind = 'memorize' | 'forget' | 'pick' | 'wander' | 'death' | 'respawn';

export type AiLogEntry = {
  t: number;
  gameTime: GameTime;
  kind: AiLogKind;
  text: string;
};

export type GameState = {
  time: GameTime;
  character: Character | null;
  resources: Resource[];
  rules: Rule[];
  recentEvents: GameEvent[];
  aiLog: AiLogEntry[];
  // "x,y" tile keys currently inside the character's vision cone (FOV + LOS,
  // matching the same scan that drives spatial memory). Sent every state_update
  // so the frontend fog-of-war can render exactly what the LLM perceives.
  // Omitted when no live character.
  visibleTiles?: string[];
  // Cumulative union of every tile ever inside the vision cone this lifetime.
  // Frontend uses this so a mid-life client reconnect shows true accumulated
  // exploration. Cleared on respawn. Omitted when no live character.
  exploredTiles?: string[];
};

export type ServerMessage =
  | { type: 'state_update'; time: GameTime; character: Character | null; resources: Resource[]; recentEvents: GameEvent[]; aiLog: AiLogEntry[]; visibleTiles?: string[]; exploredTiles?: string[] }
  | { type: 'delta_update'; changes: Record<string, unknown> }
  | { type: 'reflection_complete'; gameDay: number; newRules: Rule[]; durationMs: number }
  | { type: 'lineage_event'; event: 'death' | 'respawn'; deceasedCharacterId?: number; reason?: string; lifespan?: { gameHours: number }; newIteration?: number }
  | { type: 'pong' };

export type ClientMessage =
  | { type: 'heartbeat' }
  | { type: 'request_full_state' };
