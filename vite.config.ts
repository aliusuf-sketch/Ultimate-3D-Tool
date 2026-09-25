import { defineConfig } from 'vitest/config';

export default defineConfig({
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: false },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
