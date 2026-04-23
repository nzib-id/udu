# Phase 6 — Polish

**Goal:** MVP ready for Nzib's long-term observation. Palette cycle, full UI, responsive, sprite animations, production-hardened.

**Estimate:** ~2-3 hours

**Prerequisites:** Phase 5 complete

## Tasks

### Time-of-day palette

- [ ] Define 4 phase palettes (dawn, day, dusk, night) — see `/guide/gameplay`
- [ ] Camera tint transition (`camera.setTint()`) with smooth lerp between phases
- [ ] Transitions: 2-minute real interpolation at each phase boundary
- [ ] Api unggun: emits radial light overlay (bright center, fade to dark at night)
- [ ] (Optional) Star background at night

### UI panels

- [ ] Stat panel: live bars for hunger/thirst/bladder/energy dengan color coding
  - green: >60, yellow: 30-60, red: <30
- [ ] Current action text box
- [ ] Time display: "Day 3, 14:30" (Day 1 = first spawn day)
- [ ] Reflection log: scrollable list of rules grouped by day, newest first
- [ ] Event log: collapsible, last 10 actions
- [ ] Lineage indicator: "Iteration #N — X rules inherited"
- [ ] Styling: minimalist, parchment/natural theme (match nature color palette)

### Sprite animations

- [ ] Character walk cycle (3-4 frames loop)
- [ ] Fire flicker (3 frames loop)
- [ ] Water flow (2 frames loop)
- [ ] Chicken walk (2 frames loop)
- [ ] Placeholder → real sprite swap once Nzib supplies

### Responsive layout

- [ ] Desktop (>1200px): side panels + main canvas
- [ ] Tablet (700-1200px): main canvas + bottom-drawer panels (swipe up)
- [ ] Mobile (<700px): canvas fullscreen, toggle panels via icon buttons
- [ ] Phaser `Scale.RESIZE` mode, listen to window resize

### Performance

- [ ] WebSocket message throttling (max 2/sec, batch state updates)
- [ ] Delta patches instead of full state (after initial load)
- [ ] Frontend: use `Phaser.GameObjects.Text` caching for labels
- [ ] Backend: prepared statements for hot-path queries

### Error handling

- [ ] Frontend: display connection error banner gracefully
- [ ] Backend: if Ollama unreachable, log warning, skip reflection, continue gameplay
- [ ] DB corruption: auto-restore from last-known-good backup (future: integrate with cron backup)

### Production hardening

- [ ] Enable HTTPS verification on cloudflared (automatic)
- [ ] pm2 `max_memory_restart: 500M` buat prevent memory leak crash
- [ ] Log rotation: pm2-logrotate module atau cron cleanup
- [ ] Backup `data/udu.db` include di `~/backup-loodee.sh`

### Documentation update

- [ ] Update dev-log with production deploy
- [ ] Screenshot final UI di `docs/public/screenshots/`
- [ ] Update README.md status badge
- [ ] Save final "Udu DONE" memory ke Loodee memory

### Launch checklist

- [ ] All 6 phases complete
- [ ] Karakter running 24/7, observed for 1+ real day
- [ ] Reflection generates rules consistently
- [ ] At least 1 death + respawn cycle observed
- [ ] DNS + cloudflared tunnel stable
- [ ] SQLite DB backup included
- [ ] docs.udu.loodee.art up-to-date
- [ ] udu.loodee.art live dan public
