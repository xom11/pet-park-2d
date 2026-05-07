// Mirror every pet under ~/.codex/pets/<id>/ into apps/web/public/pets/<id>/.
// Run after `npx codex-pets add <id>` (or `add-collection`) so the web app
// can serve the new sprites without a manual `cp`. Idempotent — re-running
// is safe and overwrites.
//
// Usage: pnpm sync:pets
//        (or: corepack pnpm sync:pets — same thing under the hood)

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SRC_DIR = path.join(homedir(), ".codex", "pets");
const DEST_DIR = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "apps",
  "web",
  "public",
  "pets",
);

type PetManifest = { id: string; spritesheetPath?: string };

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await fileExists(SRC_DIR))) {
    console.error(
      `[sync-pets] no pets installed at ${SRC_DIR}. ` +
        `Run \`npx codex-pets add <id>\` first.`,
    );
    process.exit(1);
  }
  await fs.mkdir(DEST_DIR, { recursive: true });

  const ids = (await fs.readdir(SRC_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  if (ids.length === 0) {
    console.warn(`[sync-pets] ${SRC_DIR} has no pets to sync.`);
    return;
  }

  let synced = 0;
  for (const id of ids) {
    const srcManifest = path.join(SRC_DIR, id, "pet.json");
    if (!(await fileExists(srcManifest))) {
      console.warn(`[sync-pets] skip ${id} — no pet.json`);
      continue;
    }
    const raw = await fs.readFile(srcManifest, "utf8");
    const manifest = JSON.parse(raw) as PetManifest;
    const sheetName = manifest.spritesheetPath ?? "spritesheet.webp";
    const srcSheet = path.join(SRC_DIR, id, sheetName);
    if (!(await fileExists(srcSheet))) {
      console.warn(`[sync-pets] skip ${id} — sheet missing at ${srcSheet}`);
      continue;
    }
    const destPetDir = path.join(DEST_DIR, id);
    await fs.mkdir(destPetDir, { recursive: true });
    await fs.copyFile(srcManifest, path.join(destPetDir, "pet.json"));
    await fs.copyFile(srcSheet, path.join(destPetDir, sheetName));
    synced++;
    console.log(`[sync-pets] ✓ ${id}`);
  }
  console.log(`[sync-pets] synced ${synced}/${ids.length} pets to ${DEST_DIR}`);
  console.log(
    `[sync-pets] reminder: register new IDs in packages/shared/src/index.ts ` +
      `(PETS) and apps/web/src/assets/pets.ts (PET_ASSETS).`,
  );
}

main().catch((err) => {
  console.error("[sync-pets] failed:", err);
  process.exit(1);
});
