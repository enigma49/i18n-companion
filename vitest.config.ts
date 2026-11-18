import {defineConfig} from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Each test copies a fixture to a temp dir; a few workers is plenty and keeps the laptop cool.
    maxWorkers: 2,
    testTimeout: 20000,
  },
});
