# pet-park-2d

A 2D web multiplayer pet game where each visitor spawns as a random Codex Pet on a shared top-down map and can walk around. Sibling/companion to the 3D `pet-park` repo.

> **Status**: empty repo. Only `CLAUDE.md` exists. The next Claude Code session is expected to scaffold the monorepo following this brief.

## Why this repo exists (read first)

`pet-park` (sibling at `/Users/kln/Documents/dev/pet-park`) was scaffolded for **3D R3F + GLTF** under the assumption Codex Pet would ship `.glb` models. On 2026-05-07 we tested `npx codex-pets add dario` and `https://codex-pets.net/api/pets/<id>/download` — both work, but the asset format is **2D spritesheet (`.webp`) + `pet.json` manifest**, not 3D. Owner chose to fork the concept into this dedicated 2D repo rather than retrofit the 3D codebase or do a 2.5D billboard hack.

- `pet-park` (3D) stays as-is. It works end-to-end with placeholder Khronos Fox.glb.
- `pet-park-2d` (this repo) is the production direction once Codex Pet sprites land.
- The two will likely diverge — do **not** try to share a frontend.

## v1 Scope

- Up to 20 concurrent players per room
- Random Codex Pet assigned on join
- Random spawn position on a top-down map
- Movement: WASD analog (8 directions), Space = visual bounce
- Mobile: joystick + Jump button (same UX as `pet-park` 3D)
- Multiplayer sync via Colyseus, server-authoritative
- No chat, minigames, persistence, or auth in v1

Anything beyond this is v2+ and needs an explicit go-ahead from the owner.

## Tech Stack (proposed — not yet implemented)

**Monorepo** (pnpm workspaces, mirror `pet-park`):

- `apps/web` — Vite + React + TypeScript + plain HTML Canvas 2D rendering
- `apps/server` — Node.js + Colyseus 0.15.x (server-authoritative)
- `packages/shared` — types + constants crossing the wire

**Frontend**

- React for HUD + lifecycle. Game world drawn into a `<canvas>` via `getContext("2d")`. **No PixiJS in v1** — zero new deps; revisit if particles/lighting/atlas-packing become needed.
- `colyseus.js` 0.16.x (must match server pin)
- `zustand` for tiny client state stores
- `nipplejs` for mobile joystick

**Backend**

- `@colyseus/core` 0.15.x — **named import**, NOT `colyseus` (the wrapper at 0.15.x lacks `exports` field, breaks Node ESM; same constraint inherited from `pet-park`)
- `@colyseus/ws-transport` 0.15.x — pass `WebSocketTransport` explicitly to `new Server({ transport: ... })`
- `@colyseus/schema` 2.x

**Hosting**

- Frontend → Vercel
- Game server → Fly.io / Railway. **Not Vercel** — needs persistent WebSocket.

## Codex Pet Asset Format (key info — **not documented anywhere except here**)

### Install

Pets are installed via the official CLI (already verified working on 2026-05-07):

```bash
npx codex-pets add <pet-id>
# e.g. npx codex-pets add dario
```

Files land in `~/.codex/pets/<id>/`:

```
~/.codex/pets/<id>/
├── pet.json              # manifest (~250 B)
└── spritesheet.webp      # animation atlas (~1.7 MB typical)
```

`pet.json` shape:

```json
{
  "id": "dario",
  "displayName": "Dario",
  "description": "A tiny frustrated Codex pet inspired by Dario, CEO of Anthropic, with curly dark hair, black glasses, furrowed brow, and skeptical grimace.",
  "spritesheetPath": "spritesheet.webp"
}
```

### Spritesheet layout

Source of truth: `https://codex-pets.net/api/pets/<id>/share-data` returns a `validationReport` with the exact dimensions. For `dario`:

- **Cell size**: 192 × 208 px
- **Atlas**: 1536 × 1872 px → **8 columns × 9 rows**
- **9 animation states**, one per row, 8 frames per state (left → right)

The official **row → state mapping is NOT in `pet.json`**. It must be inspected visually (open the codex-pets web app, or render each row and label by hand). For v1 default, assume:

| Row | State (assumed) |
|---|---|
| 0 | idle |
| 1 | walk |
| 2 | jump (or substitute another) |
| 3–8 | unused in v1 — wire later |

If a pet's sheet diverges, override per-pet inside the shared `petManifest`. Don't hardcode the mapping inside renderer code.

### Bundling pets into this repo

The web app should serve pets from `apps/web/public/pets/<id>/`. After `npx codex-pets add <id>`:

```bash
mkdir -p apps/web/public/pets/<id>
cp ~/.codex/pets/<id>/pet.json apps/web/public/pets/<id>/
cp ~/.codex/pets/<id>/spritesheet.webp apps/web/public/pets/<id>/
# Then add `"<id>"` to the PETS array in packages/shared/src/index.ts
```

Already installed locally (not yet copied into a repo): `dario` at `~/.codex/pets/dario/`.

A small `scripts/sync-pets.ts` that walks `~/.codex/pets/` and mirrors into `apps/web/public/pets/` is worth adding when there's a 2nd or 3rd pet — until then a manual `cp` is fine.

### Codex Pet API — quick reference

- `GET https://codex-pets.net/api/pets/<id>/share-data` → JSON metadata (includes `validationReport.cellSize`, `atlasSize`, `statesDetected`, etc.). Use this to populate the per-pet manifest entry programmatically.
- `GET https://codex-pets.net/api/pets/<id>/download?v=<token>` → ZIP (the `v=` token comes from share-data; the npm CLI handles this).
- `GET https://codex-pets.net/api/collections/<slug>` → list of pets in a collection (npm CLI also supports `add-collection`).

The npm package source is at `node_modules/codex-pets/src/installer.js` — short, ~210 lines, no third-party deps. Worth re-reading if the API contract changes.

## Architecture Principles (mirrors `pet-park` 3D)

1. **Authoritative server.** Server holds canonical state; clients send input only.
2. **State sync via Colyseus schema.** Diff-replicates automatically.
3. **Client interpolation.** Render remote players interpolated between snapshots — never snap.
4. **Shared types.** Anything crossing the wire lives in `packages/shared`.
5. **Server is dimension-agnostic.** It's the `pet-park` server with one less axis. Position is `{x, y}` (plus optional bounce-Y for visual) — no `z`, no gravity.

## Roadmap

1. Monorepo skeleton: pnpm workspaces, tsconfig, biome/prettier — copy from `pet-park`
2. Canvas 2D scene: tiled grass background, render one pet sprite from a downloaded `dario` spritesheet at row 0 cycling 8 frames
3. Local-only movement: WASD walks (analog from keyboard), Space bounce, sprite-frame ticking at ~8 fps
4. Colyseus room: `Map<sessionId, {x, y, anim, petId, name}>`
5. Multi-client sync + interpolation, name tag overlays (DOM-positioned over canvas)
6. Random spawn from server-side spawn-area (mirror `SPAWN_AREA` from `pet-park` shared)
7. Mobile UI: nipplejs joystick + Jump button (copy `MobileControls.tsx` + `mobileInputStore.ts` from `pet-park`)
8. Multi-pet manifest: `npx codex-pets add` 2–3 more pets, sync to `public/pets/`, register in shared `PETS`
9. Deploy: Vercel (web) + Fly.io (server)

Each step ships as a small PR with a working demo (start `pnpm dev` and visit the URL).

## Conventions (same as `pet-park` 3D)

- TypeScript strict mode everywhere
- Prefer named exports
- No premature optimization for 20 players — write the obvious code first
- Server tick rate: 20Hz unless profiling says otherwise
- Player input is discrete commands `{moveX, moveY, jump}` (analog floats in `[-1, 1]`), never absolute positions
- 2D coordinates: `+X` right, `+Y` down (canvas convention) OR `+Y` up (math convention) — **pick one in shared/index.ts and document the choice**; the 3D repo used `+Z` away-from-camera so `+Y down` may feel less surprising for canvas. Don't mix.
- Don't roll your own WebSocket protocol — Colyseus schema only.
- Colyseus pinned to 0.15.x server / 0.16.x client. Do **not** bump server to 0.17 without bumping client; matchmaking response shape changed.
- Server imports `@colyseus/core`, never `colyseus`.

## Known constraints (anticipate these — do not re-discover)

- **Anim row mapping is unofficial.** v1 picks row 0 = idle, 1 = walk, 2 = jump. Verify each new pet visually. Build the renderer so the mapping is data, not code.
- **Sprite always faces camera.** Codex Pet sprites are single-direction (front-facing). v1 should NOT mirror or rotate the sprite. If/when we want left/right facing, mirror horizontally on a CSS transform or via canvas `scale(-1, 1)` — but this changes the look (e.g. text on shirt becomes mirrored), so test before shipping.
- **Jump is visual only.** Top-down 2D has no real gravity; "jump" is a `dy` offset on the sprite over ~0.6 s while frame row temporarily switches. Doesn't affect collision or position broadcast.
- **Spritesheet is ~1.7 MB per pet (webp).** 5 pets ≈ 8 MB initial load. Acceptable for v1. If it grows: lazy-load only the local player's pet eagerly, fetch others on first appearance, or atlas-pack everything into a single sheet.
- **Owner pre-existing tunnel on `localhost:5173`.** When testing Vite, the Mac has an SSH tunnel listening on `127.0.0.1:5173` that intercepts traffic before Vite. Do NOT kill it (user's). Bind Vite to a different port (`vite --port 5174`) or hit the LAN IP (`http://192.168.1.77:5173`). Same constraint inherited from `pet-park`.

## User context

- Owner: `l3n4k4` (git config). Email `ktxp8t4.05@gmail.com`. Also flagged in `~/.claude/CLAUDE.md` global.
- Background in **web design**, new to web game dev. Communicate technical concepts in **Vietnamese** with English terms-of-art kept in English. When proposing changes, lead with the recommendation and one main tradeoff so it's easy to redirect.
- Owner does not want `Co-Authored-By` in commit messages or PRs (per global instructions).
- Never change repo visibility (e.g. `gh repo edit --visibility`) without explicit confirmation.

## Reference: the 3D sibling repo

`/Users/kln/Documents/dev/pet-park` is the **architectural template** for this repo. Read these files before writing the equivalent here:

| What | Path in pet-park (3D) | Reuse strategy |
|---|---|---|
| Workspace setup | `pnpm-workspace.yaml`, `tsconfig.base.json`, root `package.json` | Copy verbatim, rename to `@pet-park-2d/*` |
| Shared types | `packages/shared/src/index.ts` | Copy + drop `z`, drop `groundY`/`gravity`/`jumpVelocity`, keep `TICK_RATE`, `SPAWN_AREA`, `PETS`, `PlayerInput`, `PlayerSnapshot` |
| Server room | `apps/server/src/rooms/ParkRoom.ts` | Copy, drop Y physics (jump is client-only visual), keep input handling, name generation, spawn picking |
| Server boot | `apps/server/src/index.ts` | Copy verbatim |
| WS URL derivation | `apps/web/src/network/Connection.tsx` (`defaultServerUrl`) | Copy verbatim — derives from `window.location.hostname` so phone-on-LAN works |
| Mobile joystick | `apps/web/src/controls/MobileControls.tsx` + `state/mobileInputStore.ts` | Copy verbatim, change axis names if 2D coord choice differs |
| Mobile CSS | `apps/web/src/styles.css` (`.mobile-controls`, `@media (pointer: coarse)`, `touch-action: none`) | Copy verbatim |

What is **not** worth porting:

- `FollowCamera.tsx`, `CameraDrag.tsx`, `cameraStore.ts` — top-down 2D doesn't need them in v1
- `LocalPlayer.tsx`, `RemotePlayer.tsx` — completely different rendering (canvas 2D vs R3F primitive)
- `assets/pets.ts` (3D manifest with GLB URLs) — replaced by a 2D manifest with sprite URLs + row mapping per pet

## Useful commands the next session may need

```bash
# Verify Codex Pet API is reachable + get sprite spec for a pet
curl -s "https://codex-pets.net/api/pets/dario/share-data" | python3 -m json.tool

# Install a pet locally (CLI handles the v=<token> dance)
npx codex-pets add <pet-id>

# Inspect dimensions of a downloaded sprite (macOS)
sips -g pixelWidth -g pixelHeight ~/.codex/pets/<id>/spritesheet.webp

# Dario's data (already installed locally as of 2026-05-07)
ls ~/.codex/pets/dario/
```

## Open questions (decide on first session)

1. **Coordinate convention**: `+Y down` (canvas-native) vs `+Y up` (math-native). Pick one, write it into `packages/shared/src/index.ts`, never mix.
2. **Jump mechanic**: pure visual bounce, or an actual short-Y physics that other clients also see? V1 default is pure-visual (no Z in network state); if multi-pet "jumping over each other" becomes a feature, promote to network state.
3. **Initial pet pool**: which pets to seed? `dario` is already on disk. Owner can install more via `npx codex-pets add <id>` or `npx codex-pets add-collection <slug>`.
4. **Asset sync**: manual `cp` for v1, or a `scripts/sync-pets.ts` that walks `~/.codex/pets/` and mirrors? Defer until 2nd pet.
