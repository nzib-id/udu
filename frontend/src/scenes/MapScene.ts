import Phaser from 'phaser';
import { CAMERA_CONFIG, MAP_CONFIG } from '../../../shared/config';
import type { Character, Resource, ServerMessage } from '../../../shared/types';
import {
  CharacterSprite,
  preloadCharacterSprites,
  registerCharacterAnimations,
} from '../entities/CharacterSprite';
import { ResourceLayer } from '../entities/ResourceLayer';
import { preloadResourceSprites, registerResourceAnimations } from '../entities/SpriteRegistry';
import { TerrainLayer, preloadTerrainSprites } from '../entities/TerrainLayer';
import { DayNightLayer } from '../entities/DayNightLayer';

const FALLBACK_TILE_A = 0x1b2a1f;
const FALLBACK_TILE_B = 0x223429;

type StateMsg = Extract<ServerMessage, { type: 'state_update' }>;

export class MapScene extends Phaser.Scene {
  private characterSprite: CharacterSprite | null = null;
  private pendingCharacter: Character | null = null;
  private pendingResources: Resource[] = [];
  private resourceLayer: ResourceLayer | null = null;
  private dayNightLayer: DayNightLayer | null = null;
  private currentTime: { day: number; hour: number; minute: number } = { day: 1, hour: 12, minute: 0 };
  // Follow character by default so the user always sees the AI on mount.
  // Any drag / pinch breaks follow; the on-screen "recenter" button or the
  // SPACE key re-engages it.
  private followCharacter = true;
  // How many tiles we try to show across the shorter viewport axis at
  // default zoom. 15 tiles gives the character plus ~7 tiles of context on
  // each side — tight enough to read sprites, loose enough for situational
  // awareness. Clamped up to the cover-floor so the map never letterboxes.
  private readonly DEFAULT_TILES_VIEW = 15;
  private panKeys: {
    up: Phaser.Input.Keyboard.Key;
    down: Phaser.Input.Keyboard.Key;
    left: Phaser.Input.Keyboard.Key;
    right: Phaser.Input.Keyboard.Key;
    recenter: Phaser.Input.Keyboard.Key;
  } | null = null;
  private dragging = false;
  private dragLastX = 0;
  private dragLastY = 0;
  // Pinch state — when two pointers are active we track their previous
  // distance and midpoint so we can compute zoom delta and keep the pinch
  // centre anchored to the same world point while scaling.
  private pinching = false;
  private pinchLastDist = 0;
  private pinchLastMidX = 0;
  private pinchLastMidY = 0;

  constructor() {
    super('MapScene');
  }

  preload(): void {
    preloadCharacterSprites(this);
    preloadResourceSprites(this);
    preloadTerrainSprites(this);
  }

  create(): void {
    const { widthTiles, heightTiles, tileSize } = MAP_CONFIG;

    // Flat fallback under the terrain atlas — hides any frame gaps if a sprite is missing.
    const bg = this.add.graphics();
    for (let y = 0; y < heightTiles; y++) {
      for (let x = 0; x < widthTiles; x++) {
        const color = (x + y) % 2 === 0 ? FALLBACK_TILE_A : FALLBACK_TILE_B;
        bg.fillStyle(color, 1);
        bg.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);
      }
    }
    bg.setDepth(-1);

    new TerrainLayer(this);

    // Default camera origin is (0.5, 0.5) which offsets the rendered world
    // by (cam.size - displayedSize) / 2 — on portrait phones where zoom is
    // tall-axis-limited, that offset pushes the world past the bottom of
    // the canvas and leaves a big black band. Origin (0, 0) makes scrollX/Y
    // behave as "world coord at the top-left of the viewport", matching
    // the mental model our clampScroll / follow math is built around.
    this.cameras.main.setOrigin(0, 0);

    // No setBounds — Phaser's internal clamp fights our manual scrollX/Y
    // writes (pinch, follow lerp, drag). `clampScroll()` handles bounds
    // explicitly on every write path.
    this.fitCamera();

    this.scale.on('resize', (size: Phaser.Structs.Size) => {
      const cam = this.cameras.main;
      cam.setSize(size.width, size.height);
      if (this.followCharacter) {
        // Haven't been interacted with — re-fit fresh for the new size.
        this.fitCamera();
      } else {
        // Preserve pinched zoom; only raise if it'd now letterbox. Snap so
        // post-resize zoom stays pixel-perfect.
        const floor = this.fitZoom();
        if (cam.zoom < floor) cam.setZoom(this.snapZoomPixelPerfect(floor, floor));
        this.clampScroll();
      }
    });

    // External recenter trigger (on-screen button, postMessage, etc.).
    this.game.events.on('recenter', () => this.recenterOnCharacter());

    registerCharacterAnimations(this);
    registerResourceAnimations(this);
    this.resourceLayer = new ResourceLayer(this);
    this.dayNightLayer = new DayNightLayer(this);

    this.setupCameraControls();

    this.game.events.on('state_update', (msg: StateMsg) => {
      if (msg.character) this.pendingCharacter = msg.character;
      this.pendingResources = msg.resources;
      if (msg.time) this.currentTime = msg.time;
    });

    if (this.pendingCharacter) {
      this.spawnCharacter(this.pendingCharacter);
    }
    if (this.pendingResources.length) {
      this.resourceLayer.render(this.pendingResources);
    }
  }

  update(_time: number, delta: number): void {
    const nowMs = performance.now();
    if (this.resourceLayer) {
      if (this.pendingResources.length) this.resourceLayer.render(this.pendingResources);
      this.resourceLayer.tick(nowMs);
    }
    if (!this.characterSprite && this.pendingCharacter) {
      this.spawnCharacter(this.pendingCharacter);
    }
    if (this.characterSprite && this.pendingCharacter) {
      this.characterSprite.update(delta, this.pendingCharacter);
      if (this.resourceLayer) {
        const act = this.pendingCharacter.currentAction;
        const shakingId = act?.type === 'shake_tree' && act.target ? act.target : null;
        this.resourceLayer.setShakingTree(shakingId);
        const pos = this.pendingCharacter.position;
        this.resourceLayer.setCharacterTile(pos.x, pos.y);
      }
      if (this.followCharacter) {
        const go = this.characterSprite.gameObject();
        const cam = this.cameras.main;
        const smooth = CAMERA_CONFIG.followRecenterSmoothing;
        cam.scrollX += (go.x - cam.width / (2 * cam.zoom) - cam.scrollX) * smooth;
        cam.scrollY += (go.y - cam.height / (2 * cam.zoom) - cam.scrollY) * smooth;
        this.clampScroll();
      }
    }

    this.applyKeyboardPan(delta);

    // Day/night overlay must follow camera (zoom + scroll) every frame, so
    // update it after pan/follow so it sees the final viewport state.
    if (this.dayNightLayer) this.dayNightLayer.update(this.currentTime);
  }

  private setupCameraControls(): void {
    // Phaser defaults to 1 active touch pointer — enable a second so pinch
    // gestures populate pointer1 + pointer2 concurrently.
    this.input.addPointer(1);

    const kb = this.input.keyboard;
    if (kb) {
      this.panKeys = {
        up: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
        down: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
        left: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
        right: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
        recenter: kb.addKey(Phaser.Input.Keyboard.KeyCodes.SPACE),
      };
      this.panKeys.recenter.on('down', () => {
        this.followCharacter = true;
      });
      // Arrow keys as alternative
      kb.addKey(Phaser.Input.Keyboard.KeyCodes.UP).on('down', () => (this.followCharacter = false));
      kb.addKey(Phaser.Input.Keyboard.KeyCodes.DOWN).on('down', () => (this.followCharacter = false));
      kb.addKey(Phaser.Input.Keyboard.KeyCodes.LEFT).on('down', () => (this.followCharacter = false));
      kb.addKey(Phaser.Input.Keyboard.KeyCodes.RIGHT).on('down', () => (this.followCharacter = false));
    }

    this.input.on(
      'wheel',
      (p: Phaser.Input.Pointer, _go: unknown, _dx: number, dy: number) => {
        const step = CAMERA_CONFIG.zoomStep;
        const cam = this.cameras.main;
        const next = dy > 0 ? cam.zoom - step : cam.zoom + step;
        this.zoomAround(p.x, p.y, next);
      },
    );

    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      // Second pointer promotes the gesture to a pinch — abandon drag so
      // scrollX/Y don't jump as the second finger enters.
      if (p1?.isDown && p2?.isDown) {
        this.dragging = false;
        this.pinching = true;
        this.pinchLastDist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
        this.pinchLastMidX = (p1.x + p2.x) / 2;
        this.pinchLastMidY = (p1.y + p2.y) / 2;
        return;
      }
      this.dragging = true;
      this.dragLastX = p.x;
      this.dragLastY = p.y;
    });
    this.input.on('pointerup', () => {
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      const bothDown = !!(p1?.isDown && p2?.isDown);
      const wasPinching = this.pinching;
      if (!bothDown) {
        this.pinching = false;
        this.pinchLastDist = 0;
      }
      // When a pinch ends but one finger is still down, resume drag from
      // that pointer — otherwise the user is stuck (no fresh pointerdown
      // fires for the finger already on screen).
      if (wasPinching && !bothDown) {
        const remaining = p1?.isDown ? p1 : p2?.isDown ? p2 : null;
        if (remaining) {
          this.dragging = true;
          this.dragLastX = remaining.x;
          this.dragLastY = remaining.y;
          return;
        }
      }
      this.dragging = false;
    });
    this.input.on('pointerupoutside', () => {
      this.pinching = false;
      this.pinchLastDist = 0;
      this.dragging = false;
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      const p1 = this.input.pointer1;
      const p2 = this.input.pointer2;
      if (this.pinching && p1?.isDown && p2?.isDown) {
        const dist = Phaser.Math.Distance.Between(p1.x, p1.y, p2.x, p2.y);
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        if (this.pinchLastDist > 0 && dist > 0) {
          const cam = this.cameras.main;
          // Pan by midpoint delta so two fingers sliding together drag the
          // view; zoom-anchor on current midpoint so spreading/pinching
          // scales around where the fingers are.
          const panDx = midX - this.pinchLastMidX;
          const panDy = midY - this.pinchLastMidY;
          cam.scrollX -= panDx / cam.zoom;
          cam.scrollY -= panDy / cam.zoom;
          const scale = dist / this.pinchLastDist;
          this.zoomAround(midX, midY, cam.zoom * scale);
          this.followCharacter = false;
        }
        this.pinchLastDist = dist;
        this.pinchLastMidX = midX;
        this.pinchLastMidY = midY;
        return;
      }
      if (!this.dragging) return;
      const dx = p.x - this.dragLastX;
      const dy = p.y - this.dragLastY;
      this.dragLastX = p.x;
      this.dragLastY = p.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) this.followCharacter = false;
      const cam = this.cameras.main;
      cam.scrollX -= dx / cam.zoom;
      cam.scrollY -= dy / cam.zoom;
      this.clampScroll();
    });
  }

  // Zoom while keeping the world point under (screenX, screenY) anchored.
  // Clamps to [fitZoom..maxZoom] so the map always covers the viewport.
  private zoomAround(screenX: number, screenY: number, nextZoom: number): void {
    const cam = this.cameras.main;
    const floor = Math.max(CAMERA_CONFIG.minZoom, this.fitZoom());
    const clamped = Math.max(floor, Math.min(CAMERA_CONFIG.maxZoom, nextZoom));
    const snapped = this.snapZoomPixelPerfect(clamped, floor);
    const worldX = cam.scrollX + screenX / cam.zoom;
    const worldY = cam.scrollY + screenY / cam.zoom;
    cam.setZoom(snapped);
    cam.scrollX = worldX - screenX / cam.zoom;
    cam.scrollY = worldY - screenY / cam.zoom;
    this.clampScroll();
  }

  // Keep scroll within map bounds. When the viewport is larger than the
  // world on an axis (tall portrait phone + short map), centre the scroll
  // on that axis so the letterbox is symmetrical — otherwise pinning to 0
  // glues the map to the top/left and dumps all the black space below/right.
  private clampScroll(): void {
    const worldW = MAP_CONFIG.widthTiles * MAP_CONFIG.tileSize;
    const worldH = MAP_CONFIG.heightTiles * MAP_CONFIG.tileSize;
    const cam = this.cameras.main;
    const viewW = cam.width / cam.zoom;
    const viewH = cam.height / cam.zoom;
    cam.scrollX =
      viewW >= worldW
        ? (worldW - viewW) / 2
        : Math.max(0, Math.min(worldW - viewW, cam.scrollX));
    cam.scrollY =
      viewH >= worldH
        ? (worldH - viewH) / 2
        : Math.max(0, Math.min(worldH - viewH, cam.scrollY));
  }

  private applyKeyboardPan(delta: number): void {
    if (!this.panKeys) return;
    const cam = this.cameras.main;
    const speed = CAMERA_CONFIG.panSpeedPxPerSec * (delta / 1000) / cam.zoom;
    let dx = 0;
    let dy = 0;
    if (this.panKeys.up.isDown) dy -= speed;
    if (this.panKeys.down.isDown) dy += speed;
    if (this.panKeys.left.isDown) dx -= speed;
    if (this.panKeys.right.isDown) dx += speed;
    if (dx !== 0 || dy !== 0) {
      cam.scrollX += dx;
      cam.scrollY += dy;
      this.followCharacter = false;
    }
  }

  private spawnCharacter(character: Character): void {
    this.characterSprite = new CharacterSprite(this, character);
    // First spawn — snap the camera to the character so we don't visibly
    // lerp from world centre while the player is watching.
    if (this.followCharacter) {
      const go = this.characterSprite.gameObject();
      this.cameras.main.centerOn(go.x, go.y);
      this.clampScroll();
    }
  }

  recenterOnCharacter(): void {
    this.followCharacter = true;
    this.fitCamera();
  }

  // Cover floor — smallest zoom that fills the viewport on both axes with
  // map content. Below this you'd see black letterbox on one axis; we use
  // this as the hard minimum for pinch-out and window resize.
  private fitZoom(): number {
    const { widthTiles, heightTiles, tileSize } = MAP_CONFIG;
    const cam = this.cameras.main;
    return Math.max(cam.width / (widthTiles * tileSize), cam.height / (heightTiles * tileSize));
  }

  // Snap zoom to a value where (zoom × tileSize) is integer — guarantees each
  // source pixel maps to a whole number of screen pixels (no jaggies/doubling
  // at non-integer scales). Always >= floor so we never re-introduce the
  // letterbox / black-bar regression. Capped at maxZoom on the upper end.
  private snapZoomPixelPerfect(z: number, floor: number): number {
    const unit = 1 / MAP_CONFIG.tileSize;
    const snapped = Math.round(z / unit) * unit;
    const aboveFloor = snapped < floor ? Math.ceil(floor / unit) * unit : snapped;
    return Math.min(aboveFloor, CAMERA_CONFIG.maxZoom);
  }

  // Default zoom — the "feels right on any device" level. Aims for
  // DEFAULT_TILES_VIEW tiles across the shorter viewport dimension, but
  // never below cover floor (so portrait phones still get a filled screen).
  private defaultZoom(): number {
    const cam = this.cameras.main;
    const target =
      Math.min(cam.width, cam.height) / (this.DEFAULT_TILES_VIEW * MAP_CONFIG.tileSize);
    return Math.max(this.fitZoom(), target);
  }

  private fitCamera(): void {
    const { widthTiles, heightTiles, tileSize } = MAP_CONFIG;
    const worldW = widthTiles * tileSize;
    const worldH = heightTiles * tileSize;
    const cam = this.cameras.main;
    const zoom = this.defaultZoom();
    const floor = Math.max(CAMERA_CONFIG.minZoom, this.fitZoom());
    const clamped = Math.max(floor, Math.min(CAMERA_CONFIG.maxZoom, zoom));
    cam.setZoom(this.snapZoomPixelPerfect(clamped, floor));
    // Centre on character when available, otherwise map centre.
    const sprite = this.characterSprite?.gameObject();
    if (sprite) cam.centerOn(sprite.x, sprite.y);
    else cam.centerOn(worldW / 2, worldH / 2);
    this.clampScroll();
  }
}
