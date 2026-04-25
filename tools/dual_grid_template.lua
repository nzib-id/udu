-- Dual-Grid Tileset Template Generator for Aseprite
-- Place in: File > Scripts > Open Scripts Folder, then File > Scripts > Rescan
-- Run via: File > Scripts > dual_grid_template
--
-- Creates a 128x64 sprite with:
--   - Layer "guide"    : corner markers showing which corners are "on" per tile
--   - Layer "grid-hint": faint 8px half-tile lines
--   - Layer "dirt"     : empty, paint dirt overlay here (cols 0-3)
--   - Layer "water"    : empty, paint water overlay here (cols 4-7)

local TILE = 16
local COLS = 8
local ROWS = 4
local W = COLS * TILE
local H = ROWS * TILE

local sprite = Sprite(W, H, ColorMode.RGB)
sprite.filename = "terrain_template.aseprite"
app.command.SetGridBounds{ bounds = Rectangle(0, 0, TILE, TILE) }

-- Remove the default layer once we add our own
local defaultLayer = sprite.layers[1]

-- Helper to build a layer + cel
local function addLayer(name)
  local layer = sprite:newLayer()
  layer.name = name
  local img = Image(W, H, ColorMode.RGB)
  sprite:newCel(layer, 1, img, Point(0, 0))
  return layer, img
end

-- ---------- grid-hint layer (faint lines) ----------
local gridLayer, gridImg = addLayer("grid-hint")
gridLayer.opacity = 80
local lineColor = app.pixelColor.rgba(80, 80, 80, 255)
local halfColor = app.pixelColor.rgba(50, 50, 50, 255)
-- full tile grid (every 16px)
for x = 0, W, TILE do
  for y = 0, H - 1 do if x < W then gridImg:drawPixel(x, y, lineColor) end end
end
for y = 0, H, TILE do
  for x = 0, W - 1 do if y < H then gridImg:drawPixel(x, y, lineColor) end end
end
-- half-tile lines (every 8px, dimmer) - these are the corner boundaries
for x = 8, W - 1, TILE do
  for y = 0, H - 1 do if y % 2 == 0 then gridImg:drawPixel(x, y, halfColor) end end
end
for y = 8, H - 1, TILE do
  for x = 0, W - 1 do if x % 2 == 0 then gridImg:drawPixel(x, y, halfColor) end end
end

-- ---------- guide layer (corner markers) ----------
local guideLayer, guideImg = addLayer("guide")
guideLayer.opacity = 180

-- Each tile has 4 corners (8x8 each). Mark corners that are "on" with a color stamp.
-- Convention (same as Loodee's frameForTile):
--   col 0: TL=0 TR=0, col 1: TL=1 TR=0, col 2: TL=0 TR=1, col 3: TL=1 TR=1
--   row 0: BL=0 BR=0, row 1: BL=1 BR=0, row 2: BL=0 BR=1, row 3: BL=1 BR=1
local function markCorner(img, tileX, tileY, corner, color)
  -- corner: "TL", "TR", "BL", "BR"
  local ox, oy = 0, 0
  if corner == "TR" then ox = 8 end
  if corner == "BL" then oy = 8 end
  if corner == "BR" then ox = 8; oy = 8 end
  for dx = 0, 7 do
    for dy = 0, 7 do
      -- Draw a filled 8x8 square minus 1px margin
      if dx > 0 and dy > 0 and dx < 7 and dy < 7 then
        img:drawPixel(tileX * TILE + ox + dx, tileY * TILE + oy + dy, color)
      end
    end
  end
end

local DIRT_C  = app.pixelColor.rgba(139, 107, 61, 200)   -- brown
local WATER_C = app.pixelColor.rgba(59, 106, 154, 200)   -- blue

for blockIdx = 0, 1 do
  local color = (blockIdx == 0) and DIRT_C or WATER_C
  local baseCol = blockIdx * 4
  for row = 0, 3 do
    for col = 0, 3 do
      local TL = (col == 1 or col == 3)
      local TR = (col == 2 or col == 3)
      local BL = (row == 1 or row == 3)
      local BR = (row == 2 or row == 3)
      if TL then markCorner(guideImg, baseCol + col, row, "TL", color) end
      if TR then markCorner(guideImg, baseCol + col, row, "TR", color) end
      if BL then markCorner(guideImg, baseCol + col, row, "BL", color) end
      if BR then markCorner(guideImg, baseCol + col, row, "BR", color) end
    end
  end
end

-- ---------- paint layers ----------
addLayer("water")
addLayer("dirt")

-- Drop the default layer
sprite:deleteLayer(defaultLayer)

-- Put paint layers on top (dirt above water so dirt is active first)
app.command.GotoFirstLayer()
app.refresh()

app.alert("Template ready!\n\n" ..
  "Layers:\n" ..
  "  - grid-hint: tile + half-tile guides (hide after done)\n" ..
  "  - guide: corner markers showing which corner is 'on'\n" ..
  "  - dirt: paint dirt overlay in cols 0-3 (x=0..63)\n" ..
  "  - water: paint water overlay in cols 4-7 (x=64..127)\n\n" ..
  "Draw edges THROUGH TILE CENTER (not at tile edges).\n" ..
  "Transparent = grass base will show through.\n\n" ..
  "When done: hide/delete 'grid-hint' + 'guide' layers, then\n" ..
  "File > Export Sprite Sheet (or just Export PNG) to\n" ..
  "projects/udu/frontend/public/sprites/tiles/terrain.png")
