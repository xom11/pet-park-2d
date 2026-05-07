// Codex Pet sprite manifest. The official `pet.json` does NOT include the
// row→state mapping — it has to be inferred per pet (see CLAUDE.md). For each
// pet, hard-code which row of the spritesheet corresponds to which animation
// state. v1 trusts the heuristic from CLAUDE.md (row 0 idle, 1 walk, 2 jump);
// flip per-pet here if a sheet diverges.

export type AnimMap = {
  idle: number;
  walk: number;
  jump: number;
};

export type PetAsset = {
  id: string;
  spritesheetUrl: string;
  cellWidth: number;
  cellHeight: number;
  cols: number; // frames per animation (per row)
  rows: number; // animation states (one per row)
  animMap: AnimMap;
  // Drawn size in CSS pixels; spritesheet is 192x208 native which is huge for
  // a top-down avatar, so we scale down. Tweak per pet if needed.
  drawScale: number;
};

// All Codex Pet sheets ship as 8 cols × 9 rows of 192×208 cells. The
// row→state mapping is unofficial — verify visually if a new sheet is
// added (open the spritesheet in any image viewer and read off rows).
const COMMON: Pick<PetAsset, "cellWidth" | "cellHeight" | "cols" | "rows"> = {
  cellWidth: 192,
  cellHeight: 208,
  cols: 8,
  rows: 9,
};

const DEFAULT_ANIM_MAP: AnimMap = { idle: 0, walk: 1, jump: 2 };

function pet(id: string, drawScale = 0.85, animMap = DEFAULT_ANIM_MAP): PetAsset {
  return {
    id,
    spritesheetUrl: `/pets/${id}/spritesheet.webp`,
    ...COMMON,
    animMap,
    drawScale,
  };
}

export const PET_ASSETS: Record<string, PetAsset> = {
  dario: pet("dario"),
  "lol-poro": pet("lol-poro"),
  "bubble-pao-pao": pet("bubble-pao-pao"),
  "panda-delegate": pet("panda-delegate"),
  "ada-lovelace": pet("ada-lovelace"),
};

export const FALLBACK_PET_ID = "dario";

export function getPetAsset(petId: string | null | undefined): PetAsset {
  if (petId && PET_ASSETS[petId]) return PET_ASSETS[petId];
  return PET_ASSETS[FALLBACK_PET_ID]!;
}
