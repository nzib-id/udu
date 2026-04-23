# Gameplay

## Time

- **1 menit real = 1 jam game**
- **1 game-day = 24 menit real**
- Cycle: Dawn (05:00-07:00) → Day (07:00-17:00) → Dusk (17:00-19:00) → Night (19:00-05:00)

## Map

- Size: **80 × 60 tiles** (logical grid, 16px/tile = 1280 × 960 worldspace)
- Camera zoom 2-3x untuk display
- Config-driven (JSON/TS) — expand-friendly

### Scene elements (MVP)

- 🌳 Pohon (dengan buah hanging)
- 🌿 Semak (dengan berry)
- 🌊 Sungai (air infinite, spot mancing)
- 🔥 Api unggun (cook station)
- 🪵 Kayu (tergeletak, random spots)
- 🐔 Ayam hutan (land protein)
- 🐟 Ikan di sungai (water protein)

## Stats

| Stat | Range | Decay rate | Efek jika 0 |
|------|-------|------------|-------------|
| hunger | 0-100 | -2/game-hour | Health loss |
| thirst | 0-100 | -4/game-hour | Health loss |
| bladder | 0-100 (naik) | +3/game-hour | Stress / reduced decision quality |
| energy | 0-100 | -3/game-hour aktif, +10/game-hour tidur | Forced sleep / reduced speed |

**Note:** Di MVP "observation mode", `health` TIDAK lethal dari hunger/thirst=0. Tapi karakter bisa mati setelah X game-hour di status kritis (TBD di Phase 5).

Decay rates bisa di-tune di `game-config.ts`.

## Resources

| Resource | Regen rate | Effect jika dimakan |
|----------|------------|---------------------|
| Berry (bush) | Regrow tiap 1 game-day | Hunger +15 |
| Buah (pohon) | Regrow tiap 3 game-days | Hunger +25 |
| Air (sungai) | Infinite | Thirst +30 |
| Ayam hutan | Spawn random, butuh kill | Meat → cook atau eat raw |
| Ikan | Spawn di spot sungai tertentu | Meat → cook atau eat raw |
| Kayu (tool) | Spawn random, persistent | No durability; digunakan untuk hunt |

### Meat mechanic (hybrid cook)

- **Raw meat:** Hunger +30, sickness +20 (status effect sementara)
- **Cooked meat:** Hunger +50, no sickness

Karakter **belajar** mana optimal via reflection engine.

## Hunting

- **Ayam hutan:** Lambat, kalo liat karakter cuma menjauh, gak kabur full. Harus deket + pakai kayu → kill → drop meat.
- **Ikan:** Stationary di spot sungai. Karakter diem di tepi → "mancing" (butuh kayu) → kill → drop fish meat.
- **Tool:** Kayu, ambil sekali pakai terus (NO durability di MVP)

## Death

- Karakter mati kalo hunger atau thirst = 0 selama **6 game-hour** (6 menit real)
- Atau health = 0 (kondisi lain, TBD)
- Pada mati: karakter baru spawn di spot random (jauh dari karakter mati)
- **Rules (hasil reflection) DIWARISKAN** ke karakter baru sebagai "spirit memory"
- Stats karakter baru fresh (hunger/thirst/energy 100, bladder 0)
- Lineage counter bertambah (iteration #1, #2, ...)

## Character actions (Utility AI options)

Action set yang di-score tiap tick:

1. `walk_to(target)` — pergi ke lokasi
2. `eat_berry(bush)` — makan berry dari bush terdekat yang ada berry-nya
3. `eat_fruit(tree)` — makan buah dari pohon
4. `drink(river)` — minum air dari sungai
5. `pickup_wood(wood)` — ambil kayu
6. `hunt(animal)` — serang hewan (butuh kayu di inventory)
7. `cook_meat(fire, meat)` — taruh meat di api unggun, tunggu X detik
8. `eat_meat(meat)` — makan (raw atau cooked)
9. `defecate()` — buang air di spot jauh dari sungai/resource
10. `sleep()` — tidur (energy refill)
11. `wander()` — default action saat semua stat OK, explore area

## Scoring function (initial)

Setiap action di-score 0-100 berdasarkan:

```
score(action) = base_utility(action)
              + stat_urgency_modifier(action, stats)
              + proximity_modifier(action, current_pos)
              + learned_rule_modifier(action, rules)
```

Contoh:
- `eat_berry(bush_A)` dengan hunger=70:
  - base_utility = 50
  - urgency modifier (hunger tinggi) = +30
  - proximity (bush_A 5 tiles away) = +10
  - learned rule ("bush_A berry bikin sakit") = -50
  - **Total = 40**

Jadi karakter mungkin skip bush_A dan cari bush_B.

## Palette (time-of-day)

4-phase canvas tint:
- **Dawn:** warm orange-pink (#FFB980), low contrast
- **Day:** bright natural (#FFFFFF), full saturation
- **Dusk:** purple-orange (#D77A5C), medium contrast
- **Night:** deep blue (#1A2E4C), low brightness + api unggun emits radial light
