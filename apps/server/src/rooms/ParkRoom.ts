import { Room, type Client } from "@colyseus/core";
import { Schema, MapSchema, type } from "@colyseus/schema";
import {
  INPUT_MESSAGE,
  MAX_PLAYERS_PER_ROOM,
  PETS,
  PHYSICS,
  SPAWN_AREA,
  TICK_INTERVAL_MS,
  type AnimationState,
  type PlayerInput,
} from "@pet-park-2d/shared";

class Player extends Schema {
  @type("string") sessionId = "";
  @type("string") petId = "dario";
  @type("string") name = "anon";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("string") anim: AnimationState = "idle";
}

class ParkState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}

const NAME_PREFIXES = [
  "Brave",
  "Quick",
  "Sneaky",
  "Sleepy",
  "Fluffy",
  "Tiny",
  "Mighty",
  "Curious",
  "Gentle",
  "Wild",
];

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

function randomBetween(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function clampInput(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < -1) return -1;
  if (n > 1) return 1;
  return n;
}

// Visual-only jump: when the client sends a jump pulse the server flips anim
// to "jump" for this many ms so other clients see a bounce. Position is not
// affected — true to the top-down convention documented in CLAUDE.md.
const JUMP_VISUAL_MS = 600;

type PlayerRuntime = {
  input: PlayerInput;
  jumpUntil: number;
};

export class ParkRoom extends Room<ParkState> {
  maxClients = MAX_PLAYERS_PER_ROOM;

  private runtime = new Map<string, PlayerRuntime>();

  override onCreate() {
    this.setState(new ParkState());
    this.setPatchRate(TICK_INTERVAL_MS);
    this.setSimulationInterval(
      (deltaTime) => this.tick(deltaTime),
      TICK_INTERVAL_MS,
    );

    this.onMessage<PlayerInput>(INPUT_MESSAGE, (client, input) => {
      const rt = this.runtime.get(client.sessionId);
      if (!rt) return;
      rt.input.moveX = clampInput(input?.moveX);
      rt.input.moveY = clampInput(input?.moveY);
      const wasJumping = rt.input.jump;
      rt.input.jump = !!input?.jump;
      if (rt.input.jump && !wasJumping) {
        rt.jumpUntil = Date.now() + JUMP_VISUAL_MS;
      }
    });
  }

  override onJoin(client: Client) {
    const player = new Player();
    player.sessionId = client.sessionId;
    player.petId = pick(PETS);
    player.name = `${pick(NAME_PREFIXES)} ${player.petId}`;
    player.x = randomBetween(SPAWN_AREA.minX, SPAWN_AREA.maxX);
    player.y = randomBetween(SPAWN_AREA.minY, SPAWN_AREA.maxY);
    this.state.players.set(client.sessionId, player);
    this.runtime.set(client.sessionId, {
      input: { moveX: 0, moveY: 0, jump: false },
      jumpUntil: 0,
    });
    console.log(`[park] join ${client.sessionId} as ${player.name}`);
  }

  override onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.runtime.delete(client.sessionId);
    console.log(`[park] leave ${client.sessionId}`);
  }

  private tick(deltaMs: number) {
    const dt = deltaMs / 1000;
    const now = Date.now();

    this.state.players.forEach((player, sessionId) => {
      const rt = this.runtime.get(sessionId);
      if (!rt) return;
      const { input } = rt;

      // Preserve magnitude (≤1) so analog joystick gives partial-throttle
      // walking; only scale down if input came in over-magnitude (e.g. WS+AD
      // pressed together gives ~1.41 before normalization).
      const mag = Math.hypot(input.moveX, input.moveY);
      const factor = mag > 1 ? 1 / mag : 1;
      const isMoving = mag > 0.05;
      const vx = input.moveX * factor;
      const vy = input.moveY * factor;

      player.x += vx * PHYSICS.walkSpeed * dt;
      player.y += vy * PHYSICS.walkSpeed * dt;

      const jumping = rt.jumpUntil > now;
      player.anim = jumping ? "jump" : isMoving ? "walk" : "idle";
    });
  }
}
