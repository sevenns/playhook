// Every worker points the file logger at a throwaway directory before any module under test loads.
// Without this, a test that trips a `log.warn` (a corrupt-file case, a controller sequence) appends to
// the developer's REAL launcher log under userData — logger.ts falls back to that path when nobody has
// called setLogBaseDir, exactly as it does for the GUI.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setLogBaseDir } from '../src/main/logger';

setLogBaseDir(fs.mkdtempSync(path.join(os.tmpdir(), 'playhook-test-')));
