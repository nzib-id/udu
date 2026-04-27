// Runtime severity labels for stat values. Injected into state lines as
// `hunger=98 (full)` so the LLM gets context for mixed-effect actions
// (eg eat raw meat: hunger+25 / sickness+20 — verdict depends on whether
// hunger is "starving" or "full" at this tick).
//
// Bands match the polarity grouping in SYSTEM_BLOCKs:
// - hunger/thirst/energy/health: HIGH=good, label by how depleted/comfortable
// - sickness/bladder: HIGH=bad, label by how urgent the pressure is
// - temperature: comfort band centered on 22°C
//
// Need-bands ("low"/"dehydrated"/"collapsed"/"urgent") are aligned to
// THRESHOLDS in shared/config.ts so the LLM only sees an urgency label when
// the system itself considers the need triggered. Mismatch caused the LLM to
// eat/drink/sleep prematurely (hunger=49 felt "low" even though
// hungerTrigger=35 hadn't fired).

export function severity(stat: string, value: number): string {
  if (stat === 'hunger') {
    if (value <= 20) return 'starving';
    if (value <= 35) return 'low';
    if (value <= 80) return 'moderate';
    return 'full';
  }
  if (stat === 'thirst') {
    if (value <= 10) return 'dehydrated';
    if (value <= 25) return 'low';
    if (value <= 80) return 'moderate';
    return 'hydrated';
  }
  if (stat === 'energy') {
    if (value <= 8) return 'collapsed';
    if (value <= 15) return 'low';
    if (value <= 80) return 'moderate';
    return 'fresh';
  }
  if (stat === 'health') {
    if (value <= 20) return 'dying';
    if (value <= 50) return 'wounded';
    if (value <= 80) return 'hurt';
    return 'full';
  }
  if (stat === 'sickness') {
    if (value <= 5) return 'healthy';
    if (value <= 30) return 'mild';
    if (value <= 60) return 'rising';
    return 'very sick';
  }
  if (stat === 'bladder') {
    if (value <= 20) return 'empty';
    if (value <= 50) return 'mild';
    if (value <= 85) return 'rising';
    return 'urgent';
  }
  if (stat === 'temperature') {
    if (value < 12) return 'cold';
    if (value < 18) return 'cool';
    if (value <= 25) return 'comfortable';
    if (value <= 32) return 'warm';
    return 'hot';
  }
  return '';
}
