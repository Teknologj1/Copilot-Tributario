import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // NODE_ENV=teste mantem o motor destravado (nao e producao) e permite a
    // chave de criptografia efemera de processo.
    env: { NODE_ENV: 'teste' },
    restoreMocks: true,
  },
});
