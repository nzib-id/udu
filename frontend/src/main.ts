import Phaser from 'phaser';
import { MAP_CONFIG } from '../../shared/config';
import { MapScene } from './scenes/MapScene';
import { connectGameSocket } from './network/ws-client';
import { bindHud } from './ui/hud';

function viewport() {
  const vv = window.visualViewport;
  return {
    w: Math.round(vv?.width ?? window.innerWidth),
    h: Math.round(vv?.height ?? window.innerHeight),
  };
}

const { w: initW, h: initH } = viewport();
const game = new Phaser.Game({
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0a0a0a',
  scale: {
    mode: Phaser.Scale.RESIZE,
    autoCenter: Phaser.Scale.CENTER_BOTH,
    width: initW,
    height: initH,
  },
  pixelArt: true,
  roundPixels: true,
  scene: [MapScene],
});

// iOS Safari's URL bar resize + orientation changes don't always trigger
// Phaser's internal resize. Force-sync via visualViewport when available.
const syncSize = () => {
  const { w, h } = viewport();
  game.scale.resize(w, h);
};
window.addEventListener('resize', syncSize);
window.addEventListener('orientationchange', () => setTimeout(syncSize, 150));
window.visualViewport?.addEventListener('resize', syncSize);

const hud = bindHud({
  time: document.getElementById('hud-time')!,
  char: document.getElementById('hud-char')!,
  resources: document.getElementById('hud-resources')!,
  inv: document.getElementById('hud-inv')!,
  status: document.getElementById('status')!,
  stats: document.getElementById('stats')!,
  goal: document.getElementById('hud-goal')!,
  dailyGoal: document.getElementById('hud-goal-daily')!,
  reasoning: document.getElementById('hud-reasoning')!,
  log: document.getElementById('hud-log')!,
  bars: {
    hunger: document.getElementById('bar-hunger')!,
    thirst: document.getElementById('bar-thirst')!,
    bladder: document.getElementById('bar-bladder')!,
    energy: document.getElementById('bar-energy')!,
    sickness: document.getElementById('bar-sickness')!,
    health: document.getElementById('bar-health')!,
    temperature: document.getElementById('bar-temperature')!,
  },
  vals: {
    hunger: document.getElementById('val-hunger')!,
    thirst: document.getElementById('val-thirst')!,
    bladder: document.getElementById('val-bladder')!,
    energy: document.getElementById('val-energy')!,
    sickness: document.getElementById('val-sickness')!,
    health: document.getElementById('val-health')!,
    temperature: document.getElementById('val-temperature')!,
  },
});

connectGameSocket({
  onState: (state) => {
    hud.update(state);
    game.events.emit('state_update', state);
  },
  onStatus: (status) => hud.setStatus(status),
});

(window as any).__UDU_GAME__ = game;

// Admin token: captured from `?admin=<token>` URL param, then stripped from
// the URL bar (history.replaceState) and stashed in sessionStorage so a reload
// keeps the bookmark holder admin without leaking the token via copy-paste.
// Public visitors never have this set, so admin tooling stays invisible.
const ADMIN_TOKEN_KEY = 'udu-admin-token';
function captureAdminToken(): string | null {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get('admin');
    if (fromUrl) {
      sessionStorage.setItem(ADMIN_TOKEN_KEY, fromUrl);
      url.searchParams.delete('admin');
      window.history.replaceState({}, '', url.toString());
      return fromUrl;
    }
    return sessionStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}
const adminToken = captureAdminToken();
const adminHeaders = (): Record<string, string> =>
  adminToken ? { 'x-admin-token': adminToken } : {};

// Speed toggle — debug-only game-time multiplier wired to /api/admin/speed.
// User pick persists in localStorage. On mount we re-assert the persisted
// value against the backend (it resets to 1× on container restart) so a
// reload doesn't silently revert the player's choice.
function bindSpeedToggle(): void {
  const root = document.getElementById('speed-toggle');
  if (!root) return;
  if (!adminToken) {
    // Public viewers can't drive game speed — hide the control entirely.
    (root as HTMLElement).style.display = 'none';
    return;
  }
  const KEY = 'udu-speed-multiplier';
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-speed]'));
  const setActive = (n: number): void => {
    for (const b of buttons) {
      const v = Number(b.dataset.speed);
      b.classList.toggle('active', v === n);
    }
  };
  const setDisabled = (d: boolean): void => {
    for (const b of buttons) b.disabled = d;
  };
  const persist = (n: number): void => {
    try { localStorage.setItem(KEY, String(n)); } catch { /* ignore quota / disabled */ }
  };
  const post = (n: number): Promise<number | null> =>
    fetch('/api/admin/speed', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...adminHeaders() },
      body: JSON.stringify({ multiplier: n }),
    })
      .then((r) => r.json())
      .then((data: { ok?: boolean; multiplier?: number }) =>
        data.ok && typeof data.multiplier === 'number' ? data.multiplier : null,
      )
      .catch(() => null);
  let saved: number | null = null;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw === null ? null : Number(raw);
    if (parsed === 1 || parsed === 2 || parsed === 3) saved = parsed;
  } catch { /* ignore */ }
  if (saved !== null && saved !== 1) {
    // Persisted non-default — re-assert to backend so the active multiplier
    // matches the visible UI even after a backend restart.
    setActive(saved);
    void post(saved);
  } else {
    fetch('/api/admin/speed', { headers: adminHeaders() })
      .then((r) => r.json())
      .then((data: { multiplier?: number }) => {
        if (typeof data.multiplier === 'number') setActive(data.multiplier);
      })
      .catch(() => { /* backend down — leave default 1x */ });
  }
  for (const b of buttons) {
    b.addEventListener('click', () => {
      const n = Number(b.dataset.speed);
      if (!Number.isFinite(n)) return;
      setDisabled(true);
      void post(n)
        .then((m) => {
          if (m !== null) {
            setActive(m);
            persist(m);
          }
        })
        .finally(() => setDisabled(false));
    });
  }
}
bindSpeedToggle();

// Fog of war on/off — purely client-side, persists in localStorage so the
// player's preference survives reloads. State is mirrored to the MapScene via
// a Phaser game-event so we don't reach into scene internals from here.
function bindFogToggle(): void {
  const root = document.getElementById('fog-toggle');
  if (!root) return;
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button[data-fog]'));
  const KEY = 'udu-fog-enabled';
  const setActive = (on: boolean): void => {
    for (const b of buttons) b.classList.toggle('active', (b.dataset.fog === 'on') === on);
  };
  const apply = (on: boolean): void => {
    setActive(on);
    game.events.emit('fog:set', on);
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* ignore quota / disabled */ }
  };
  let initial = true;
  try { initial = localStorage.getItem(KEY) !== '0'; } catch { /* default on */ }
  apply(initial);
  for (const b of buttons) {
    b.addEventListener('click', () => apply(b.dataset.fog === 'on'));
  }
}
bindFogToggle();

export {};
void MAP_CONFIG;
