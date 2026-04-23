# Sprite Spec

Nzib's input — semua sprite di-draw manual. AI (Loodee) ngerjain semua code dan wiring.

## Specifications

- **Format**: PNG dengan transparency
- **Base tile size**: 16×16 pixels
- **Larger objects** (pohon, api unggun) bisa 16×32 atau 32×32 — spesifik di list
- **Palette**: limited ~8-16 colors, konsisten antar asset
- **Style reference**: cute chunky pixel art (ala Stardew Valley / Terraria)
- **Save location**: `frontend/public/assets/sprites/<category>/<name>.png`

## Mandatory (MVP)

### Karakter (character/)
| File | Size | Notes |
|------|------|-------|
| `idle.png` | 16×16 | 1 frame |
| `walk.png` | 48×16 (or 64×16) | 3-4 frames horizontal strip |

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
