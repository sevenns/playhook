// vitest runs in a plain Node environment with NO electron runtime (audit C1/M-4). Modules under
// test pull `electron` transitively (logger.ts → app.getPath), so we alias the bare `electron`
// specifier to an inert stub. koffi-bound modules (game-launcher.ts) still cannot be imported — their
// pure logic was split into launch-args.ts precisely so it is testable without the native FFI addon.
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
    environment: 'node',
  },
});
