import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['test/global-setup.ts'],
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    environment: 'node',
    // 시험이 서버 프로세스를 여러 개 띄우고 DB를 공유한다. 파일을 너무 많이 동시에 돌리면 시간 의존 시험이 부하로 흔들린다.
    maxWorkers: 4,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
