import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    restoreMocks: true,
    unstubEnvs: true,
    unstubGlobals: true,
    projects: [
      {
        test: {
          name: 'extension',
          include: ['extension/test/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'host',
          include: ['host/test/**/*.test.ts'],
          globalSetup: ['host/test/global-setup.ts'],
        },
      },
      {
        test: {
          name: 'scripts',
          include: ['scripts/test/**/*.test.ts'],
        },
      },
    ],
  },
});
