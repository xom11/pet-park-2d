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

// Pixels per world unit. World is in unitless coords; the renderer maps to px
// here. Tweak to zoom in/out without touching physics.
const WORLD_SCALE = 32;

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
};

type RenderEntry = {
  // Last-rendered position (smoothed towards target).
  rx: number;
  ry: number;
  // Per-pet animation phase so two players on the same anim aren't lockstep.
  frame: number;
  frameTimer: number;
  facing: Facing;
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

      // Background
      if (grassPattern) {
        // Translate the pattern so it scrolls with the camera. The translation
        // must be modulo TILE_SIZE so floats don't drift over time.
        ctx.save();
        const offX = ((-camX * WORLD_SCALE) % TILE_SIZE + TILE_SIZE) % TILE_SIZE;
        const offY = ((-camY * WORLD_SCALE) % TILE_SIZE + TILE_SIZE) % TILE_SIZE;
        ctx.translate(offX - TILE_SIZE, offY - TILE_SIZE);
        ctx.fillStyle = grassPattern;
        ctx.fillRect(
          -offX,
          -offY,
          width + TILE_SIZE * 2,
          height + TILE_SIZE * 2,
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
      const sx = (-12 - camX) * WORLD_SCALE + halfW;
      const sy = (-12 - camY) * WORLD_SCALE + halfH;
      const sw = 24 * WORLD_SCALE;
      const sh = 24 * WORLD_SCALE;
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
                  ) * BOUNCE_HEIGHT_PX
                : 0,
            anim: local.anim,
            petId: snap.petId,
            name: snap.name,
            isLocal: true,
            facing: local.facing,
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
                  BOUNCE_HEIGHT_PX
                : 0,
            anim: snap.anim,
            petId: snap.petId,
            name: snap.name,
            isLocal: false,
            facing: r ? r.facing : 1,
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

      for (const d of drawables) {
        const screenX = (d.worldX - camX) * WORLD_SCALE + halfW;
        const screenY = (d.worldY - camY) * WORLD_SCALE + halfH;
        drawPet(ctx, d, screenX, screenY, remoteRender, petScaleMul);
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
        // Idle locks to frame 0 because some Codex sheets have empty frames in
        // the idle row that briefly hide the pet ("flicker"). Walk and jump
        // tick through all 8 frames so the cycle reads as motion. Remote
        // players use a per-entry timer initialized on first sight so two
        // pets on the same anim aren't lockstep.
        let frame: number;
        if (d.anim === "idle") {
          frame = 0;
        } else if (d.isLocal) {
          frame = local.frame;
        } else {
          let r = remoteRender.get(d.sessionId);
          if (!r) {
            r = { rx: 0, ry: 0, frame: 0, frameTimer: 0, facing: 1 };
            remoteRender.set(d.sessionId, r);
          }
          frame = r.frame;
        }
        const row = asset.animMap[d.anim] ?? 0;
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
      // empty in the sheet. Reset timer when entering idle so the next walk
      // starts from frame 0.
      const framePeriod = 1 / FRAME_FPS;
      if (local.anim === "idle") {
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
          };
          remoteRender.set(snap.sessionId, r);
        }
        // Derive facing from x-delta. The delta is per network update which
        // arrives at TICK_RATE Hz; small jitter floor avoids flipping facing
        // on idle micro-corrections.
        const dx = snap.x - r.rx;
        if (dx > 0.02) r.facing = 1;
        else if (dx < -0.02) r.facing = -1;
        const k = 1 - Math.exp(-REMOTE_LERP_RATE * dt);
        r.rx += (snap.x - r.rx) * k;
        r.ry += (snap.y - r.ry) * k;
        if (snap.anim === "idle") {
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

      // Camera follows the local player.
      const camX = local.x;
      const camY = local.y;

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
    };
  }, []);

  return <canvas ref={canvasRef} />;
}
