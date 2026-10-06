import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 単体テストはsrc/配下のみ。e2e/はPlaywright専用で、test.describe()を
    // 使うためvitestのテストランナーに読ませると衝突する。
    include: ['src/**/*.test.ts'],
  },
});
