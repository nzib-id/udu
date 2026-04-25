# Sprite Spec

Nzib's input — semua sprite di-draw manual. AI (Loodee) ngerjain semua code dan wiring.

## Specifications

- **Format**: PNG dengan transparency
- **Base tile size**: 16×16 pixels
- **Larger objects** (pohon, api unggun) bisa 16×32 atau 32×32 — spesifik di list
- **Palette**: limited ~8-16 colors, konsisten antar asset
- **Style reference**: cute chunky pixel art (ala Stardew Valley / Terraria)
- **Save location**: `frontend/public/sprites/<category>/<name>.png`

## Mandatory (MVP)

### Karakter (`frontend/public/sprites/char/`) — ✅ delivered 2026-04-24

| File | Size | Frames | Used for |
|------|------|--------|----------|
| `man_idle.png` | 64×16 | 4 | Default standing loop |
| `man_walk.png` | 64×16 | 4 | Walking (right-facing; left via horizontal flip) |
| `man_bow.png` | 96×16 | 6 | Menunduk — transition idle↔sit↔sleep, pickup ground item, place meat on fire |
| `man_sit.png` | 64×16 | 4 | Duduk (defecate, rest, wait-cooking) |
| `man_use.png` | 32×16 | 2 | Eat / drink / use consumable |
| `man_reach_up.png` | 64×16 | 4 | Pick berry bush, pick fruit direct from tree |
| `man_shake.png` | 32×16 | 2 | Shake pohon (fruit drop) |
| `man_swing.png` | 64×16 | 4 | Swing ke bawah — hunt ayam, fish |
| `man_sleep.png` | 64×16 | 4 | Rebahan tidur |
| `man_die.png` | 96×16 | 6 | Collapse (Phase 5 death) |

**Mapping action → sprite:**
- `walk_to` → `walk`
- `eat_berry` / `eat_fruit` / `eat_meat` / `drink` → `reach_up` (pick from bush/tree) or `bow` (pick from ground) + `use` (to mouth)
- `shake_tree` → `shake`
- `pickup_wood` / `pickup_fruit_ground` → `bow`
- `hunt` / `fish` → `swing`
- `defecate` / `rest` → `bow` (in) + `sit` (hold) + `bow` (out)
- `sleep` → `bow` (in) + `sleep` (hold) + `bow` (out)
- `cook_place` → `bow`; `cook_wait` → `sit`; `cook_collect` → `bow`; `eat_cooked` → `use`
- `die` → `die`

### Terrain (terrain/)
| File | Size | Notes |
|------|------|-------|
| `grass_1.png` | 16×16 | Default ground |
| `grass_2.png` | 16×16 | Variant (subtle difference) |
| `dirt.png` | 16×16 | Alternative ground |
| `water.png` | 32×16 | 2 frames (water flow animation) |

### Flora (flora/)
| File | Size | Notes |
|------|------|-------|
| `tree.png` | 16×32 | Can be taller if preferred |
| `tree_fruit.png` | 16×32 | Same tree but with visible fruit |
| `bush_full.png` | 16×16 | Bush with berries |
| `bush_empty.png` | 16×16 | Bush after harvest |
| `berry_ground.png` | 16×16 | (Optional) dropped berry sprite |

### Structures (structures/)
| File | Size | Notes |
|------|------|-------|
| `fire_unlit.png` | 16×16 | Pile of wood, no flame |
| `fire_lit.png` | 48×16 | 3 frames animation (flicker) |

### Items (items/)
| File | Size | Notes |
|------|------|-------|
| `wood.png` | 16×16 | Kayu tergeletak di tanah |
| `meat_raw.png` | 16×16 | Raw meat item |
| `meat_cooked.png` | 16×16 | Cooked meat item |

### Animals (animals/)
| File | Size | Notes |
|------|------|-------|
| `chicken_idle.png` | 16×16 | 1 frame |
| `chicken_walk.png` | 32×16 | 2 frames |
| `fish_idle.png` | 16×16 | 1 frame (subtle ripple style) |

## Optional (v1.5+, can defer)

| File | Size | Notes |
|------|------|-------|
| `sleep_zzz.png` | 16×16 | Speech bubble for sleep state |
| `exclaim.png` | 16×16 | "!" bubble for alert |
| `question.png` | 16×16 | "?" bubble for confused |
| `skull.png` | 16×16 | Death marker at location |

## Palette guidance

Suggested core palette (Nzib bisa override):

```
Nature:    #4A7C3A (grass green)
           #2E4F1E (dark grass)
           #8B5A2B (tree trunk brown)
           #5E8D3A (leaves)
Water:     #3E78B2 (river blue)
           #5A9ACF (river highlight)
Fire:      #E8B33F (flame yellow)
           #D64B33 (flame red)
Character: #C4914F (skin tan)
           #6B3E20 (hair brown)
UI accent: #F4E5C2 (parchment)
           #1A1A1A (ink black)
```

## Format requirements

- **Transparent background** (no white fill)
- **Pixel-perfect** — no antialiasing
- **No padding** — sprite fills full tile boundaries where appropriate
- **Consistent sub-pixel alignment** — characters centered horizontally in their tile

## Delivery workflow

1. Nzib drops PNG files ke `frontend/public/assets/sprites/<category>/<name>.png`
2. Loodee pick up via `this.load.image(key, path)` di Phaser scene preload
3. If any sprite missing, Loodee render placeholder colored rectangle + log warning
4. Swap-in new sprite → restart frontend → live update

## Tools suggestion (for Nzib)

- **Aseprite** (paid, $20 once, standard for pixel art)
- **Pixilart** (free, browser-based)
- **LibreSprite** (free Aseprite fork)
- **Pyxel Edit** (paid, alt)
