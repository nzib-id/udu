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
  // Per-phase OVERRIDE for the energy threshold that triggers reactive sleep.
  // Lower = char only sleeps when truly drained; higher = char sleeps earlier.
  // Morning/afternoon: push through, only sleep on near-collapse. Evening:
  // start winding down. Night: sleep early (recovery is ×1.8 here, decay
  // awake is ×1.5 — both push the same way).
  energySleepTrigger: PhaseMap;
} = {
  energyDecay:    { morning: 0.7, afternoon: 1.0, evening: 1.2, night: 1.5 },
  thirstDecay:    { morning: 1.0, afternoon: 1.3, evening: 1.0, night: 0.6 },
  hungerDecay:    { morning: 1.1, afternoon: 1.0, evening: 1.0, night: 0.5 },
  bladderDecay:   { morning: 1.2, afternoon: 1.0, evening: 1.0, night: 0.3 },
  sleepRecovery:  { morning: 0.7, afternoon: 0.4, evening: 0.6, night: 1.8 },
  energySleepTrigger: { morning: 8, afternoon: 10, evening: 18, night: 28 },
};
