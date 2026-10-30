import { defineConfig } from 'vitest/config';

// Cada suíte sobe um Postgres (PGlite) em memória e cada cadastro calcula 11 hashes Argon2
// (senha + 10 códigos de recuperação): os testes são de integração reais, por isso os prazos maiores.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
