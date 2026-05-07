export const TICK_RATE = 20;
export const TICK_INTERVAL_MS = 1000 / TICK_RATE;
export const MAX_PLAYERS_PER_ROOM = 20;
export const ROOM_NAME = "park";

// Coordinate convention: top-down 2D, +X right, +Y DOWN (canvas-native).
// All world positions, server snapshots, and input vectors use this.

// Pets the server is allowed to assign. Each entry must have matching files at
// apps/web/public/pets/<id>/{spritesheet.webp,pet.json} on the client and a
// matching entry in the client-side PET_ASSETS manifest.
export const PETS = [
  "dario",
  "lol-poro",
  "bubble-pao-pao",
  "panda-delegate",
  "ada-lovelace",
] as const;
export type PetId = (typeof PETS)[number];

// World units, not pixels. The web client maps 1 unit -> WORLD_SCALE px.
// Spawn box is intentionally smaller than any visible bounds so 20 simultaneous
// joins don't overlap aggressively.
export const SPAWN_AREA = {
  minX: -8,
  maxX: 8,
  minY: -8,
  maxY: 8,
} as const;

// Walk speed in world units / second. Mirrors pet-park 3D so the feel is
// identical — a sprite at 0.5x scale (~96 px tall) moving at 4 u/s = 128 px/s
// across the canvas at the default 32 px/unit scale.
export const PHYSICS = {
  walkSpeed: 4,
} as const;

export const INPUT_MESSAGE = "input";

// "jump" is a visual-only state in 2D — the server flips anim to "jump" briefly
// so other clients can render a bounce animation, but no Y physics happens.
// See ParkRoom.tick for the bounce timer.
export type AnimationState = "idle" | "walk" | "jump";

export type PlayerInput = {
  moveX: number;
  moveY: number;
  jump: boolean;
};

export type PlayerSnapshot = {
  sessionId: string;
  petId: string;
  name: string;
  x: number;
  y: number;
  anim: AnimationState;
};
