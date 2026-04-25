import type { DailyGoal, ServerMessage } from '../../../shared/types';
import type { ConnectionStatus } from '../network/ws-client';

type HudElements = {
  time: HTMLElement;
  char: HTMLElement;
  resources: HTMLElement;
  inv: HTMLElement;
  status: HTMLElement;
  stats: HTMLElement;
  goal: HTMLElement;
  dailyGoal: HTMLElement;
  reasoning: HTMLElement;
  log: HTMLElement;
  bars: {
    hunger: HTMLElement;
    thirst: HTMLElement;
    bladder: HTMLElement;
    energy: HTMLElement;
    sickness: HTMLElement;
  };
  vals: {
    hunger: HTMLElement;
    thirst: HTMLElement;
    bladder: HTMLElement;
    energy: HTMLElement;
    sickness: HTMLElement;
  };
};

// For hunger/thirst/energy: low = bad. For bladder/sickness: high = bad.
function tierLow(v: number): 'ok' | 'warn' | 'crit' {
  if (v < 20) return 'crit';
  if (v < 40) return 'warn';
  return 'ok';
}
function tierHigh(v: number): 'ok' | 'warn' | 'crit' {
  if (v > 80) return 'crit';
  if (v > 60) return 'warn';
  return 'ok';
}

function applyBar(el: HTMLElement, pct: number, tier: 'ok' | 'warn' | 'crit'): void {
  el.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  el.classList.remove('warn', 'crit');
  if (tier !== 'ok') el.classList.add(tier);
}

// Icon chip driven by items.png (48×16 atlas). Frame layout: 0=fruit, 1=berry, 2=wood.
// Size doubled (32px) so the pixel art reads at normal HUD text size.
const ICON_SIZE = 32;
const ICON_SHEET = '/sprites/tiles/items.png?v=4';
function iconChip(frame: number, count: number, label: string): string {
  const bgX = -frame * ICON_SIZE;
  const style = [
    `display:inline-flex`,
    `align-items:center`,
    `gap:2px`,
    `margin-right:6px`,
  ].join(';');
  const iconStyle = [
    `display:inline-block`,
    `width:${ICON_SIZE}px`,
    `height:${ICON_SIZE}px`,
    `background:url(${ICON_SHEET}) ${bgX}px 0/${ICON_SIZE * 3}px ${ICON_SIZE}px no-repeat`,
    `image-rendering:pixelated`,
  ].join(';');
  return `<span style="${style}" title="${label}"><span style="${iconStyle}"></span>×${count}</span>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Daily goal chip — alignment drives color (green=advances, yellow=maintains,
// red=survival_override). Hidden when goal is null or already 'completed' so
// the panel doesn't clutter once the day's plan is wrapped.
function renderDailyGoal(el: HTMLElement, goal: DailyGoal | null): void {
  el.classList.remove('show', 'align-maintains', 'align-survival_override');
  if (!goal || goal.status !== 'in_progress') {
    el.innerHTML = '';
    return;
  }
  const total = goal.subGoals.length;
  const cur = goal.currentStepIdx;
  const progress = `${Math.min(cur, total)}/${total}`;
  const steps = goal.subGoals
    .map((sg, i) => {
      const cls = i < cur ? 'done' : i === cur ? 'active' : '';
      const tooltip = `success: ${sg.successCriteria}`;
      return `<li class="${cls}" title="${escapeHtml(tooltip)}">${escapeHtml(sg.text)}</li>`;
    })
    .join('');
  el.innerHTML =
    `<div class="daily-head"><span class="daily-label">Today · ${escapeHtml(goal.alignment)}</span><span class="daily-progress">${progress}</span></div>` +
    `<div class="daily-summary" title="${escapeHtml(goal.reason)}">${escapeHtml(goal.summary)}</div>` +
    `<ul class="daily-steps">${steps}</ul>`;
  el.classList.add('show');
  if (goal.alignment === 'maintains') el.classList.add('align-maintains');
  else if (goal.alignment === 'survival_override') el.classList.add('align-survival_override');
}

// Memory churn (memorize/forget) gets very chatty when the char's vision cone
// brushes wandering animals — drowns out decisions in the limited HUD feed.
// Filtered at render time; entries still stream over WS for raw debugging.
const HUD_LOG_HIDDEN = new Set(['memorize', 'forget']);

function renderLog(el: HTMLElement, log: ReadonlyArray<{ gameTime: { hour: number; minute: number }; kind: string; text: string }>): void {
  if (!log || log.length === 0) {
    el.innerHTML = '';
    return;
  }
  const rows = log
    .filter((entry) => !HUD_LOG_HIDDEN.has(entry.kind))
    .map((entry) => {
      const hh = String(entry.gameTime.hour).padStart(2, '0');
      const mm = String(entry.gameTime.minute).padStart(2, '0');
      return `<div class="log-row"><span class="log-t">${hh}:${mm}</span><span class="log-k k-${entry.kind}">${entry.kind}</span>${escapeHtml(entry.text)}</div>`;
    });
  el.innerHTML = rows.join('');
}

function formatInventory(inv: string[]): string {
  if (!inv || inv.length === 0) return 'empty';
  const counts: Record<string, number> = {};
  for (const item of inv) counts[item] = (counts[item] ?? 0) + 1;
  const parts: string[] = [];
  if (counts['fruit']) parts.push(iconChip(0, counts['fruit'], 'fruit'));
  if (counts['berry']) parts.push(iconChip(1, counts['berry'], 'berry'));
  if (counts['wood']) parts.push(iconChip(2, counts['wood'], 'wood'));
  if (counts['meat_raw']) parts.push(`raw×${counts['meat_raw']}`);
  if (counts['meat_cooked']) parts.push(`cook×${counts['meat_cooked']}`);
  const handled = new Set(['fruit', 'berry', 'wood', 'meat_raw', 'meat_cooked']);
  for (const k of Object.keys(counts)) {
    if (!handled.has(k)) parts.push(`${k}×${counts[k]}`);
  }
  return parts.join('') || 'empty';
}

export function bindHud(el: HudElements) {
  return {
    update(state: Extract<ServerMessage, { type: 'state_update' }>) {
      const { time, character, resources, aiLog } = state;
      renderLog(el.log, aiLog ?? []);
      el.time.textContent = `day ${time.day}, ${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`;
      if (character) {
        el.char.textContent = `#${character.id} iter${character.iteration} · (${character.position.x},${character.position.y}) · ${character.currentAction.type}`;
        const s = character.stats;
        const h = Math.round(s.hunger);
        const t = Math.round(s.thirst);
        const b = Math.round(s.bladder);
        const e = Math.round(s.energy);
        const sk = Math.round(s.sickness ?? 0);
        applyBar(el.bars.hunger, h, tierLow(h));
        applyBar(el.bars.thirst, t, tierLow(t));
        applyBar(el.bars.bladder, b, tierHigh(b));
        applyBar(el.bars.energy, e, tierLow(e));
        applyBar(el.bars.sickness, sk, tierHigh(sk));
        el.vals.hunger.textContent = String(h);
        el.vals.thirst.textContent = String(t);
        el.vals.bladder.textContent = String(b);
        el.vals.energy.textContent = String(e);
        el.vals.sickness.textContent = String(sk);
        el.inv.innerHTML = formatInventory(character.inventory ?? []);
        if (character.lifeGoal) {
          el.goal.innerHTML =
            `<div class="goal-head"><span class="goal-label">Life Goal</span><span class="goal-priority">P${character.lifeGoal.priority}/10</span></div>` +
            `<div class="goal-text">${escapeHtml(character.lifeGoal.text)}</div>` +
            `<div class="goal-reason">${escapeHtml(character.lifeGoal.reason)}</div>`;
          el.goal.classList.add('show');
        } else {
          el.goal.textContent = '';
          el.goal.classList.remove('show');
        }
        renderDailyGoal(el.dailyGoal, character.dailyGoal ?? null);
        if (character.lastReasoning && character.lastChoice) {
          el.reasoning.textContent = `[${character.lastChoice}] ${character.lastReasoning}`;
          el.reasoning.classList.add('show');
        } else {
          el.reasoning.textContent = '';
          el.reasoning.classList.remove('show');
        }
        el.stats.classList.add('show');
      } else {
        el.char.textContent = 'no character';
        el.inv.textContent = '—';
        el.goal.textContent = '';
        el.goal.classList.remove('show');
        el.dailyGoal.textContent = '';
        el.dailyGoal.classList.remove('show', 'align-maintains', 'align-survival_override');
        el.reasoning.textContent = '';
        el.reasoning.classList.remove('show');
        el.stats.classList.remove('show');
      }
      el.resources.textContent = String(resources.length);
    },
    setStatus(status: ConnectionStatus) {
      el.status.className = status === 'open' ? 'ok' : status === 'error' ? 'err' : 'warn';
      el.status.textContent =
        status === 'open' ? 'connected' : status === 'connecting' ? 'connecting…' : status === 'closed' ? 'reconnecting…' : 'error';
    },
  };
}
