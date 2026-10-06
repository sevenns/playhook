// vitest runs in a plain Node environment with NO electron runtime. Modules under
// test pull `electron` transitively (logger.ts → app.getPath), so we alias the bare `electron`
// specifier to an inert stub. The koffi-bound modules (game-launcher.ts) import fine — the addon is
// prebuilt and binds its DLLs lazily — but their FFI branches only run on Windows, which is why their
// pure logic lives in launch-args.ts and the process waits reach the controller through a seam.
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      electron: path.resolve(__dirname, 'test/stubs/electron.ts'),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    environmentMatchGlobs: [['test/renderer/**', 'happy-dom']],
  },
});
