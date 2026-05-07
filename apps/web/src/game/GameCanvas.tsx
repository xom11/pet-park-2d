import { useEffect, useRef } from "react";
import {
  INPUT_MESSAGE,
  PHYSICS,
  TICK_INTERVAL_MS,
  type AnimationState,
} from "@pet-park-2d/shared";
import { getRoom } from "../network/Connection";
import {
  getAllSnapshots,
  getSnapshot,
  useNetworkStore,
} from "../state/networkStore";
import { useMobileInputStore } from "../state/mobileInputStore";
import { getPetAsset } from "../assets/pets";
import { getSprite, loadSprite } from "./spriteCache";

// Pixels per world unit at default zoom. World is in unitless coords; the
// renderer maps to px through `zoom` (a runtime variable initialised to this
// default). Pinch updates `zoom`; sprite/grass scale relative to default so
// the zoom feels uniform across the whole scene.
const DEFAULT_ZOOM = 32;
const ZOOM_MIN = 14;
const ZOOM_MAX = 96;
const clampZoom = (z: number) =>
  Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

// Sprite frame ticking. 8 frames at 8 fps = 1 s per loop.
const FRAME_FPS = 8;
const FRAMES_PER_ROW = 8;

const TICK_INTERVAL_S = TICK_INTERVAL_MS / 1000;

// Visual-only bounce for the local jump. Server flips anim to "jump" for
// JUMP_VISUAL_MS too, so other clients see the same bounce timing on us.
const BOUNCE_DURATION = 0.6;
const BOUNCE_HEIGHT_PX = 28;

// Remote interpolation: each frame we lerp render position towards the latest
// server snapshot at this rate. With TICK_RATE=20 (50 ms) and a smoothing
// factor around 12 the visible delay is ~80 ms, which hides jitter without
// feeling laggy. Promote to bracketed interpolation if 20 players highlight a
// problem.
const REMOTE_LERP_RATE = 12;

// Grass tile size (px). Drawn via createPattern from an offscreen canvas built
// once at startup.
const TILE_SIZE = 64;

// Drag-to-pan / pinch-to-zoom camera. One pointer = pan; two pointers =
// pinch (zoom anchored on midpoint, plus midpoint pan). The offset eases
// back to 0 while the player is moving and not gesturing — so standing
// still lets you peek around, and walking re-centers smoothly. Skip
// selector matches widgets that have their own pointer behavior so they
// aren't hijacked.
const CAMERA_DRAG_SKIP_SELECTOR =
  ".mobile-joystick-zone, .mobile-jump-button, .hud, .player-count";
const CAMERA_RECENTER_RATE = 3;

type Facing = 1 | -1;

type LocalState = {
  x: number;
  y: number;
  initialized: boolean;
  anim: AnimationState;
  frame: number;
  frameTimer: number;
  bounceTimer: number;
  pendingJumpToSend: boolean;
  // +1 sprite drawn as-is (faces "right"), -1 mirrored horizontally so the
  // character reads as "facing left". Codex Pet sheets are single-direction
  // (front-facing); flipping is the cheapest way to give the player a sense
  // of facing without adding more sheet rows.
  facing: Facing;
  isMoving: boolean;
};

type RenderEntry = {
  // Last-rendered position (smoothed towards target).
  rx: number;
  ry: number;
  // Per-pet animation phase so two players on the same anim aren't lockstep.
  frame: number;
  frameTimer: number;
  facing: Facing;
  // Derived from snap-vs-rx delta each frame. We need this independent of
  // snap.anim because snap.anim === "jump" doesn't tell us whether the remote
  // is also moving — and the visual row depends on that distinction.
  isMoving: boolean;
};

function buildGrassPattern(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = TILE_SIZE;
  c.height = TILE_SIZE;
  const ctx = c.getContext("2d")!;
  // Base color — kept light enough that dark-toned pets still read clearly
  // against the grass.
  ctx.fillStyle = "#5ca65f";
  ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
  for (let i = 0; i < 18; i++) {
    const x = Math.random() * TILE_SIZE;
    const y = Math.random() * TILE_SIZE;
    const r = 1.2 + Math.random() * 1.5;
    ctx.fillStyle = Math.random() > 0.5 ? "#73bd76" : "#4d9650";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 5; i++) {
    const x = Math.random() * TILE_SIZE;
    const y = Math.random() * TILE_SIZE;
    ctx.fillStyle = "#86d188";
    ctx.fillRect(x, y, 1, 2);
    ctx.fillRect(x + 1, y - 1, 1, 1);
    ctx.fillRect(x - 1, y, 1, 1);
  }
  return c;
}

export function GameCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Sprites are loaded lazily — the first time we see a pet (in the local
    // snapshot or a remote one), drawPet kicks off loadSprite and falls back
    // to a placeholder until the image arrives. This keeps initial page load
    // light even with N pets registered.

    const grassPattern = ctx.createPattern(buildGrassPattern(), "repeat");

    const local: LocalState = {
      x: 0,
      y: 0,
      initialized: false,
      anim: "idle",
      frame: 0,
      frameTimer: 0,
      bounceTimer: 0,
      pendingJumpToSend: false,
      facing: 1,
      isMoving: false,
    };

    const remoteRender = new Map<string, RenderEntry>();

    const keys = new Set<string>();
    const onKeyDown = (e: KeyboardEvent) => {
      // Stop Space from scrolling or activating focused buttons.
      if (
        e.code === "Space" ||
        e.code === "ArrowUp" ||
        e.code === "ArrowDown" ||
        e.code === "ArrowLeft" ||
        e.code === "ArrowRight"
      ) {
        e.preventDefault();
      }
      keys.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      keys.delete(e.code);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    // Camera state mutated by the pointer/pinch handlers and read in frame().
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let zoom = DEFAULT_ZOOM;

    // Active gesture pointers. Mouse button or touch contacts that started on
    // a non-skip element get tracked here; the pointer count decides between
    // pan (1) and pinch (2). Pointers that started on the joystick / jump
    // button / HUD never enter this map, so those widgets work normally.
    const pointers = new Map<number, { x: number; y: number }>();
    // Last pinch reference (distance + midpoint). Reset whenever the pointer
    // count crosses 2, so the next pinch frame establishes a fresh baseline.
    let pinch: { distance: number; midX: number; midY: number } | null = null;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (target && target.closest && target.closest(CAMERA_DRAG_SKIP_SELECTOR))
        return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      // Crossing into / out of 2 invalidates the pinch baseline.
      pinch = null;
    };
    const onPointerMove = (e: PointerEvent) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;

      if (pointers.size === 1) {
        // Single-finger / mouse pan. Convert px → world units via current
        // zoom so a 100 px swipe always covers the same on-screen distance
        // regardless of zoom level.
        const dx = e.clientX - p.x;
        const dy = e.clientY - p.y;
        dragOffsetX -= dx / zoom;
        dragOffsetY -= dy / zoom;
      }

      p.x = e.clientX;
      p.y = e.clientY;

      if (pointers.size >= 2) {
        const [a, b] = pointers.values();
        if (!a || !b) return;
        const distance = Math.hypot(b.x - a.x, b.y - a.y);
        const midX = (a.x + b.x) / 2;
        const midY = (a.y + b.y) / 2;
        if (pinch && pinch.distance > 0 && distance > 0) {
          const oldZoom = zoom;
          zoom = clampZoom(oldZoom * (distance / pinch.distance));
          // Anchor zoom on the pinch midpoint: keep the world point under
          // the midpoint stationary on screen by adjusting dragOffset.
          // World x under (midX, midY) at oldZoom is
          //   wx = camX + (midX - halfW) / oldZoom
          // We want it equal to camX_new + (midX - halfW) / zoom, so
          //   Δoffset = (midX - halfW) * (1/oldZoom - 1/zoom).
          const halfW = canvas.clientWidth / 2;
          const halfH = canvas.clientHeight / 2;
          dragOffsetX += (midX - halfW) * (1 / oldZoom - 1 / zoom);
          dragOffsetY += (midY - halfH) * (1 / oldZoom - 1 / zoom);
          // Two-finger pan: midpoint shift translates the camera.
          dragOffsetX -= (midX - pinch.midX) / zoom;
          dragOffsetY -= (midY - pinch.midY) / zoom;
        }
        pinch = { distance, midX, midY };
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      pinch = null;
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);

    let dpr = window.devicePixelRatio || 1;
    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
    };
    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let lastT = performance.now();
    let inputAcc = 0;

    const draw = (
      width: number,
      height: number,
      camX: number,
      camY: number,
    ) => {
      const halfW = width / 2;
      const halfH = height / 2;

      // Background. The grass pattern is anchored in WORLD coordinates: tiles
      // sit at fixed world spots so panning/zooming feels physical (you see
      // the same patch of grass from closer/farther rather than the pattern
      // re-tiling under you).
      const tileScale = zoom / DEFAULT_ZOOM;
      const tilePx = TILE_SIZE * tileScale;
      if (grassPattern) {
        ctx.save();
        const offX = ((-camX * zoom) % tilePx + tilePx) % tilePx;
        const offY = ((-camY * zoom) % tilePx + tilePx) % tilePx;
        // Translate to the first tile origin off-screen, then ctx.scale so the
        // (TILE_SIZE)-px source pattern tiles at tilePx on screen.
        ctx.translate(offX - tilePx, offY - tilePx);
        ctx.scale(tileScale, tileScale);
        ctx.fillStyle = grassPattern;
        ctx.fillRect(
          -offX / tileScale,
          -offY / tileScale,
          (width + tilePx * 2) / tileScale,
          (height + tilePx * 2) / tileScale,
        );
        ctx.restore();
      } else {
        ctx.fillStyle = "#2f6d34";
        ctx.fillRect(0, 0, width, height);
      }

      // Spawn area outline so the player has a visual anchor for "the park".
      // Drawn before sprites so it sits beneath everyone.
      ctx.save();
      ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
      ctx.lineWidth = 2;
      const sx = (-12 - camX) * zoom + halfW;
      const sy = (-12 - camY) * zoom + halfH;
      const sw = 24 * zoom;
      const sh = 24 * zoom;
      ctx.setLineDash([8, 8]);
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.restore();

      // Compose render list: every snapshot from the network store, plus the
      // local override (we render the local player from `local` so input
      // feels instant rather than waiting on server echo).
      const sid = useNetworkStore.getState().sessionId;
      type Drawable = {
        sessionId: string;
        worldX: number;
        worldY: number;
        bounceY: number;
        anim: AnimationState;
        petId: string;
        name: string;
        isLocal: boolean;
        facing: Facing;
        // Whether the pet is in horizontal motion this frame. Decoupled from
        // anim because a "jump" anim with no motion should render the idle
        // pose + bounce, while a "jump" anim with motion uses the walk pose.
        isMoving: boolean;
      };

      const drawables: Drawable[] = [];
      for (const snap of getAllSnapshots()) {
        const isLocal = snap.sessionId === sid;
        if (isLocal) {
          drawables.push({
            sessionId: snap.sessionId,
            worldX: local.x,
            worldY: local.y,
            bounceY:
              local.bounceTimer > 0
                ? Math.sin(
                    (1 - local.bounceTimer / BOUNCE_DURATION) * Math.PI,
                  ) *
                  BOUNCE_HEIGHT_PX *
                  tileScale
                : 0,
            anim: local.anim,
            petId: snap.petId,
            name: snap.name,
            isLocal: true,
            facing: local.facing,
            isMoving: local.isMoving,
          });
        } else {
          const r = remoteRender.get(snap.sessionId);
          drawables.push({
            sessionId: snap.sessionId,
            worldX: r ? r.rx : snap.x,
            worldY: r ? r.ry : snap.y,
            // Remote bounce derived from the server-set anim flag.
            bounceY:
              snap.anim === "jump"
                ? Math.sin(((performance.now() % 600) / 600) * Math.PI) *
                  BOUNCE_HEIGHT_PX *
                  tileScale
                : 0,
            anim: snap.anim,
            petId: snap.petId,
            name: snap.name,
            isLocal: false,
            facing: r ? r.facing : 1,
            isMoving: r ? r.isMoving : false,
          });
        }
      }

      // Sort by world Y so pets nearer the bottom of the screen draw on top —
      // the standard 2.5D depth trick. With +Y down, larger Y is "in front".
      drawables.sort((a, b) => a.worldY - b.worldY);

      // Sprites occupy ~40% of viewport width on a phone at the desktop scale —
      // shrink them so multiple pets fit on screen and the player sees more
      // of the world. Threshold 480 px matches the @media breakpoint in CSS.
      const petScaleMul = width < 480 ? 0.65 : 1;

      // Sprites scale with the same tileScale so the world feels uniform —
      // grass tile, spawn-area outline, and pets all grow/shrink together.
      const spriteScaleMul = petScaleMul * tileScale;

      for (const d of drawables) {
        const screenX = (d.worldX - camX) * zoom + halfW;
        const screenY = (d.worldY - camY) * zoom + halfH;
        drawPet(ctx, d, screenX, screenY, remoteRender, spriteScaleMul);
      }
    };

    const drawPet = (
      ctx: CanvasRenderingContext2D,
      d: {
        sessionId: string;
        anim: AnimationState;
        petId: string;
        name: string;
        bounceY: number;
        isLocal: boolean;
        facing: Facing;
        isMoving: boolean;
      },
      screenX: number,
      screenY: number,
      remoteRender: Map<string, RenderEntry>,
      petScaleMul: number,
    ) => {
      const asset = getPetAsset(d.petId);
      let img = getSprite(asset.spritesheetUrl);
      if (!img) {
        // Fire and forget — loadSprite dedupes via inflight Map so subsequent
        // calls during the load coalesce. On resolve, the next frame picks up
        // the cached image.
        loadSprite(asset.spritesheetUrl).catch(() => {});
      }

      const drawScale = asset.drawScale * petScaleMul;
      const dw = asset.cellWidth * drawScale;
      const dh = asset.cellHeight * drawScale;

      // Drop shadow sits at the world position, ignoring bounce — that's what
      // sells the bounce as a vertical offset rather than the pet floating
      // off the floor.
      ctx.save();
      ctx.fillStyle = "rgba(0, 0, 0, 0.32)";
      ctx.beginPath();
      ctx.ellipse(
        screenX,
        screenY,
        asset.cellWidth * drawScale * 0.28,
        asset.cellWidth * drawScale * 0.1,
        0,
        0,
        Math.PI * 2,
      );
      ctx.fill();
      ctx.restore();

      if (img) {
        // Pick which sheet row to render. We deliberately do NOT use
        // animMap.jump (row 2) — some Codex sheets (e.g. bubble-pao-pao) draw
        // row 2 facing the opposite direction from row 1, so flipping to it
        // mid-walk reads as the pet "turning around" during the jump. The
        // bounce y-offset already conveys "in the air"; we just keep the
        // walk pose if the pet is moving, or the idle pose if it's standing
        // still and only the bounce conveys jump.
        const rowAnim: AnimationState =
          d.anim === "jump" ? (d.isMoving ? "walk" : "idle") : d.anim;
        // Idle locks to frame 0 because some Codex sheets have empty frames
        // in the idle row that briefly hide the pet ("flicker"). Walk ticks
        // through all 8 frames so the cycle reads as motion. Remote players
        // use a per-entry timer initialized on first sight so two pets on
        // the same anim aren't lockstep.
        let frame: number;
        if (rowAnim === "idle") {
          frame = 0;
        } else if (d.isLocal) {
          frame = local.frame;
        } else {
          let r = remoteRender.get(d.sessionId);
          if (!r) {
            r = {
              rx: 0,
              ry: 0,
              frame: 0,
              frameTimer: 0,
              facing: 1,
              isMoving: false,
            };
            remoteRender.set(d.sessionId, r);
          }
          frame = r.frame;
        }
        const row = asset.animMap[rowAnim] ?? 0;
        const sx = frame * asset.cellWidth;
        const sy = row * asset.cellHeight;
        const dx = Math.round(screenX - dw / 2);
        const dy = Math.round(screenY - dh + d.bounceY * -1);
        if (d.facing === -1) {
          // Mirror horizontally around the sprite's vertical centerline. This
          // is a cheap "facing left" since Codex Pet sheets are single-direction.
          // Side effect: any text/asymmetric detail in the sprite mirrors too.
          ctx.save();
          ctx.translate(dx + dw / 2, 0);
          ctx.scale(-1, 1);
          ctx.drawImage(
            img,
            sx,
            sy,
            asset.cellWidth,
            asset.cellHeight,
            -dw / 2,
            dy,
            dw,
            dh,
          );
          ctx.restore();
        } else {
          ctx.drawImage(
            img,
            sx,
            sy,
            asset.cellWidth,
            asset.cellHeight,
            dx,
            dy,
            dw,
            dh,
          );
        }
      } else {
        // Sprite still loading — placeholder so the pet shows up immediately.
        ctx.save();
        ctx.fillStyle = "#888";
        ctx.fillRect(screenX - dw / 2, screenY - dh - d.bounceY, dw, dh);
        ctx.restore();
      }

      // Name tag
      const tagY = screenY - dh + d.bounceY * -1 - 8;
      ctx.save();
      ctx.font =
        "500 12px system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
      const text = d.name + (d.isLocal ? " (you)" : "");
      const metrics = ctx.measureText(text);
      const padX = 8;
      const padY = 3;
      const textW = metrics.width;
      const tagW = textW + padX * 2;
      const tagH = 18;
      ctx.fillStyle = d.isLocal
        ? "rgba(80, 140, 220, 0.85)"
        : "rgba(0, 0, 0, 0.65)";
      const tagX = screenX - tagW / 2;
      ctx.beginPath();
      const radius = 9;
      ctx.moveTo(tagX + radius, tagY - tagH);
      ctx.arcTo(tagX + tagW, tagY - tagH, tagX + tagW, tagY, radius);
      ctx.arcTo(tagX + tagW, tagY, tagX, tagY, radius);
      ctx.arcTo(tagX, tagY, tagX, tagY - tagH, radius);
      ctx.arcTo(tagX, tagY - tagH, tagX + tagW, tagY - tagH, radius);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.textBaseline = "middle";
      ctx.fillText(text, tagX + padX, tagY - tagH / 2);
      ctx.restore();
    };

    const frame = (now: number) => {
      const dtRaw = (now - lastT) / 1000;
      const dt = Math.min(0.1, dtRaw);
      lastT = now;

      // Lazy-init local position from server snapshot the first time we see
      // ourselves. Until then we render at (0, 0) — but draw() only renders
      // pets we actually have a snapshot for, so this isn't visible.
      const sid = useNetworkStore.getState().sessionId;
      if (!local.initialized && sid) {
        const snap = getSnapshot(sid);
        if (snap) {
          local.x = snap.x;
          local.y = snap.y;
          local.initialized = true;
        }
      }

      // Inputs ─ keyboard binary + joystick analog, summed and clamped.
      const right =
        keys.has("KeyD") || keys.has("ArrowRight") ? 1 : 0;
      const left = keys.has("KeyA") || keys.has("ArrowLeft") ? 1 : 0;
      const down = keys.has("KeyS") || keys.has("ArrowDown") ? 1 : 0;
      const up = keys.has("KeyW") || keys.has("ArrowUp") ? 1 : 0;
      const jumpKey = keys.has("Space");

      const mobile = useMobileInputStore.getState();
      const mobileJump = useMobileInputStore.getState().consumeJump();

      let inX = right - left + mobile.joyX;
      let inY = down - up + mobile.joyY;
      const inMag = Math.hypot(inX, inY);
      if (inMag > 1) {
        inX /= inMag;
        inY /= inMag;
      }
      const isMoving = Math.hypot(inX, inY) > 0.05;
      local.isMoving = isMoving;
      const jumpRequested = jumpKey || mobileJump;

      // Local prediction (matches server tick)
      if (local.initialized) {
        local.x += inX * PHYSICS.walkSpeed * dt;
        local.y += inY * PHYSICS.walkSpeed * dt;
      }

      // Bounce timer
      if (jumpRequested && local.bounceTimer <= 0) {
        local.bounceTimer = BOUNCE_DURATION;
      }
      if (local.bounceTimer > 0) {
        local.bounceTimer = Math.max(0, local.bounceTimer - dt);
      }

      local.anim =
        local.bounceTimer > 0 ? "jump" : isMoving ? "walk" : "idle";

      // Update facing only on horizontal input — vertical-only motion (W/S
      // alone) keeps the previous facing so the sprite doesn't snap back to
      // the default each time you walk down. Threshold avoids jitter on
      // analog joysticks at rest.
      if (inX > 0.1) local.facing = 1;
      else if (inX < -0.1) local.facing = -1;

      // Frame ticking — only when actually animating. Idle locks to frame 0
      // (drawPet enforces this) so we don't sweep through frames that may be
      // empty in the sheet. "Jump while standing still" also locks because
      // drawPet renders it from the idle row.
      const framePeriod = 1 / FRAME_FPS;
      const localTickFrames =
        local.anim === "walk" || (local.anim === "jump" && local.isMoving);
      if (!localTickFrames) {
        local.frame = 0;
        local.frameTimer = 0;
      } else {
        local.frameTimer += dt;
        while (local.frameTimer >= framePeriod) {
          local.frameTimer -= framePeriod;
          local.frame = (local.frame + 1) % FRAMES_PER_ROW;
        }
      }

      // Frame ticking + lerp + facing for remote pets.
      for (const snap of getAllSnapshots()) {
        if (snap.sessionId === sid) continue;
        let r = remoteRender.get(snap.sessionId);
        if (!r) {
          r = {
            rx: snap.x,
            ry: snap.y,
            frame: 0,
            frameTimer: 0,
            facing: 1,
            isMoving: false,
          };
          remoteRender.set(snap.sessionId, r);
        }
        // Derive facing + motion from snap-vs-render delta. Delta is non-zero
        // whenever the server has more recent position than what we've
        // smoothed to; when the remote stops, the lerp catches up and delta
        // collapses to ~0. Threshold avoids flipping facing on rest jitter.
        const dx = snap.x - r.rx;
        const dy = snap.y - r.ry;
        if (dx > 0.02) r.facing = 1;
        else if (dx < -0.02) r.facing = -1;
        r.isMoving = Math.hypot(dx, dy) > 0.1;
        const k = 1 - Math.exp(-REMOTE_LERP_RATE * dt);
        r.rx += (snap.x - r.rx) * k;
        r.ry += (snap.y - r.ry) * k;
        const remoteTickFrames =
          snap.anim === "walk" || (snap.anim === "jump" && r.isMoving);
        if (!remoteTickFrames) {
          r.frame = 0;
          r.frameTimer = 0;
        } else {
          r.frameTimer += dt;
          while (r.frameTimer >= framePeriod) {
            r.frameTimer -= framePeriod;
            r.frame = (r.frame + 1) % FRAMES_PER_ROW;
          }
        }
      }
      // Garbage collect render entries for sessions that have left.
      for (const id of remoteRender.keys()) {
        if (!getSnapshot(id)) remoteRender.delete(id);
      }

      // Send input at server tick rate. Stick jump as an edge so a fast tap
      // is never lost between ticks.
      if (jumpRequested) local.pendingJumpToSend = true;
      inputAcc += dt;
      if (inputAcc >= TICK_INTERVAL_S) {
        inputAcc = 0;
        const room = getRoom();
        if (room) {
          room.send(INPUT_MESSAGE, {
            moveX: inX,
            moveY: inY,
            jump: local.pendingJumpToSend,
          });
        }
        local.pendingJumpToSend = false;
      }

      // Camera follows the local player, with a drag-applied offset on top.
      // Ease the offset back to 0 while the player is moving and no drag is
      // active — standing still preserves the panned view, walking re-centers.
      if (pointers.size === 0 && local.isMoving) {
        const k = 1 - Math.exp(-CAMERA_RECENTER_RATE * dt);
        dragOffsetX += -dragOffsetX * k;
        dragOffsetY += -dragOffsetY * k;
      }
      const camX = local.x + dragOffsetX;
      const camY = local.y + dragOffsetY;

      // Render with the device pixel ratio applied.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cssWidth = canvas.clientWidth;
      const cssHeight = canvas.clientHeight;
      draw(cssWidth, cssHeight, camX, camY);

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, []);

  return <canvas ref={canvasRef} />;
}
