// Fetches the umu-launcher zipapp into resources/umu/ for the Linux (Proton) build (Р1). The zipapp is a
// ~420 KB python zipapp (umu-run) + umu_run.py; it is NOT committed to the repo — this runs before the
// Linux electron-builder pack (see build-linux.yml / `npm run build:umu`). Uses curl + tar (present on
// macOS and the ubuntu CI runner). Idempotent: skips the download if resources/umu/umu-run already exists.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pinned umu-launcher version (bump deliberately — a new Proton-runner surface is a real change).
const UMU_VERSION = '1.4.1';
const ASSET = `umu-launcher-${UMU_VERSION}-zipapp.tar`;
const URL = `https://github.com/Open-Wine-Components/umu-launcher/releases/download/${UMU_VERSION}/${ASSET}`;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const resourcesDir = join(root, 'resources');
const umuRun = join(resourcesDir, 'umu', 'umu-run');

if (existsSync(umuRun)) {
  console.log(`[fetch-umu] umu ${UMU_VERSION} already present at resources/umu — skipping.`);
  process.exit(0);
}

mkdirSync(resourcesDir, { recursive: true });
const tarPath = join(resourcesDir, ASSET);

try {
  console.log(`[fetch-umu] downloading ${ASSET} …`);
  execFileSync('curl', ['-sSL', '--fail', '-o', tarPath, URL], { stdio: 'inherit' });
  console.log('[fetch-umu] extracting into resources/ …');
  // The tar contains a top-level `umu/` dir (umu/umu-run, umu/umu_run.py).
  execFileSync('tar', ['-xf', tarPath, '-C', resourcesDir], { stdio: 'inherit' });
  if (!existsSync(umuRun)) {
    throw new Error(`extraction did not produce ${umuRun}`);
  }
  console.log('[fetch-umu] ready: resources/umu/umu-run');
} finally {
  rmSync(tarPath, { force: true });
}
