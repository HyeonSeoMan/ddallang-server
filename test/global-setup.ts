import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { sweepStaleSchemas } from './helpers/isolated-db.js';

/**
 * 모든 시험 전에 한 번: 다중 프로세스 하네스가 실행할 `dist-test`를 증분 빌드하고,
 * 이전 실행이 남긴 오래된 시험 스키마를 정리한다. DB가 없으면 정리만 건너뛴다(DB 시험이 안내와 함께 실패한다).
 */
export default async function setup(): Promise<void> {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  try {
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.test-build.json'], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    throw new Error(`dist-test 빌드 실패:\n${e.stdout ?? ''}${e.stderr ?? ''}`, { cause: err });
  }
  try {
    await sweepStaleSchemas();
  } catch {
    // DB 없음: 각 DB 시험이 안내 메시지와 함께 실패한다.
  }
}
