# Vision

## One-line

Sebuah dunia kecil berisi satu karakter primitif yang **belajar sendiri** cara bertahan hidup, dan Nzib mengamati evolusinya tanpa ikut campur.

## Filosofi

- **Emergent, bukan scripted.** Perilaku karakter muncul dari sistem (Utility AI + LLM reflection), bukan dari tree yang ditulis manual.
- **Learning is legible.** Lo bisa baca apa yang karakter "pikirin" lewat reflection log yang berbentuk kalimat natural.
- **Death has weight.** Tapi pengetahuan diturunkan — tiap death bikin generation berikutnya lebih pintar.
- **Observation-first UX.** Nzib gak ngasih command, gak ngatur, gak intervene. Dia pure observer.

## Goal

1. **Short-term (MVP):** Satu karakter bisa bertahan di dunia 80x60 tile dengan forage + hunting. Karakter belajar mana makanan aman, mana beracun, mana tempat minum yang baik. Lo bisa liat rules berakumulasi tiap malam.
2. **Mid-term (v1.5):** Musim, temperature, sickness, predator. Bikin pressure semakin nuanced.
3. **Long-term (v2+):** Tribe — banyak karakter, reproduction, oral tradition, knowledge decay & mutation antar generation, ritual emergent.

## Non-Goal

- ❌ Player control / direct interaction dengan karakter
- ❌ Combat yang dalam (fighting mechanic)
- ❌ Procedural map generation (MVP map handcrafted)
- ❌ Multiplayer
- ❌ Economy / trading / tech tree
- ❌ Graphic fidelity tinggi — 16x16 pixel art cukup

## Success criteria

MVP dianggap berhasil kalau:

1. Karakter bisa bertahan **setidaknya 3 game-days** tanpa intervensi Nzib (artinya forage loop-nya konsisten)
2. **Reflection log** berhasil ter-generate tiap malam game, minimal 3 rules berbeda
3. Karakter **tampak berubah perilakunya** setelah beberapa siklus — misal: setelah 1-2x sakit karena berry tertentu, dia skip berry itu
4. Respawn + spirit memory mechanic jalan — generation #2 punya advantage dari rules generation #1
5. Running 24/7 stable tanpa restart manual
