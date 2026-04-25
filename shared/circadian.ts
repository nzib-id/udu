// Circadian rhythm: stat decay (and sleep recovery) is multiplied by a
// time-of-day factor. Without nudging the AI explicitly, character naturally
// prefers night sleep + day activity because day-time awake = cheap and
// night-time sleep = efficient recovery. Awake at night drains hard; nap at
// noon barely recovers anything.
//
// Phase boundaries roughly track the day-night visual layer keyframes so the
// world's lighting and the character's metabolism stay aligned.

export type Phase = 'morning' | 'afternoon' | 'evening' | 'night';

export function currentPhase(gameHour: number): Phase {
  if (gameHour >= 6 && gameHour < 12) return 'morning';
  if (gameHour >= 12 && gameHour < 18) return 'afternoon';
  if (gameHour >= 18 && gameHour < 22) return 'evening';
  return 'night';
}

type PhaseMap = Record<Phase, number>;

export const CIRCADIAN: {
  energyDecay: PhaseMap;
  thirstDecay: PhaseMap;
  hungerDecay: PhaseMap;
  bladderDecay: PhaseMap;
  sleepRecovery: PhaseMap;
} = {
  // Active drain on energy. Morning fresh (×0.7), evening tired (×1.2),
  // night brutal (×1.5) — staying up late hurts.
  energyDecay:    { morning: 0.7, afternoon: 1.0, evening: 1.2, night: 1.5 },
  // Thirst spikes in the heat of the afternoon, drops at night.
  thirstDecay:    { morning: 1.0, afternoon: 1.3, evening: 1.0, night: 0.6 },
  // Hunger high after the long overnight fast, low while asleep.
  hungerDecay:    { morning: 1.1, afternoon: 1.0, evening: 1.0, night: 0.5 },
  // Bladder pressure spikes morning (overnight buildup), kidneys slow at night.
  bladderDecay:   { morning: 1.2, afternoon: 1.0, evening: 1.0, night: 0.3 },
  // Sleep efficiency: night sleep restorative (×1.8), midday nap useless (×0.4).
  sleepRecovery:  { morning: 0.7, afternoon: 0.4, evening: 0.6, night: 1.8 },
};
