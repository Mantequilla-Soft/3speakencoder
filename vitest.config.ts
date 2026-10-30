import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the automated suite. The other files in tests/ are manual scripts
    // that hit real services and are run by hand with tsx/node.
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
