import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  evaluate,
  parseMatrix,
  run,
  scanTestSource,
  tagsFromResults,
} from '../scripts/ac-check.mjs';

const MATRIX = `# 백엔드 AC 매핑표
- 문서 버전: 9.9.9 (시험용)

| AC | Spec | 구분 | 담당 Task | Spec §11 검증 |
| --- | --- | --- | --- | --- |
| AC-ROOM-001-1 | S1 | BE+FE | BE-S1-2 (+프론트엔드 Plan) | API |
| AC-ROOM-001-2 | S1 | BE | BE-S1-2 | API |
| AC-ROOM-001-12 | S1 | FE | 프론트엔드 Plan | UI |
| AC-TXN-001-1 | S2 | BE | BE-S2-2 | API |
| AC-REF-001-1 | S2 | 참조 | BE-S2-20 | 참조 |
`;
const { rows } = parseMatrix(MATRIX);

const scan = (src: string) => scanTestSource('x.spec.ts', src);
const tagsOf = (src: string) => scan(src).map((t) => t.id);

describe('AC 검사 스크립트: 표 파싱', () => {
  it('AC 행과 구분·담당 Task·버전 줄을 읽는다', () => {
    const parsed = parseMatrix(MATRIX);
    expect(parsed.rows.map((r) => [r.id, r.kind, r.spec])).toEqual([
      ['AC-ROOM-001-1', 'BE+FE', 'S1'],
      ['AC-ROOM-001-2', 'BE', 'S1'],
      ['AC-ROOM-001-12', 'FE', 'S1'],
      ['AC-TXN-001-1', 'BE', 'S2'],
      ['AC-REF-001-1', '참조', 'S2'],
    ]);
    expect(parsed.version).toContain('9.9.9');
  });
});

describe('AC 검사 스크립트: 태그 수집', () => {
  it('제목 문자열·템플릿·ac() 도우미의 태그를 읽는다', () => {
    const src = `
      it('[AC-ROOM-001-1] 문자열', () => {});
      test(\`[AC-ROOM-001-2] 템플릿\`, () => {});
      it(ac('AC-TXN-001-1', 'S2 §3.4', '도우미'), () => {});
      it(ac(['AC-REF-001-1', 'AC-ROOM-001-2'], 'S2 §3.4', '여러 개'), () => {});
      describe('[AC-ROOM-001-12] 묶음', () => {});
      it.each([1])('[AC-ROOM-001-1] each', () => {});
    `;
    expect(tagsOf(src)).toEqual([
      'AC-ROOM-001-1',
      'AC-ROOM-001-2',
      'AC-TXN-001-1',
      'AC-REF-001-1',
      'AC-ROOM-001-2',
      'AC-ROOM-001-12',
      'AC-ROOM-001-1',
    ]);
  });

  it('주석과 시험 본문 안의 문자열은 세지 않는다', () => {
    const src = `
      // it('[AC-ROOM-001-1] 주석')
      /* it('[AC-ROOM-001-2] 블록 주석') */
      it('태그 없는 시험', () => {
        const s = "[AC-TXN-001-1]";
        helper('[AC-REF-001-1]');
      });
    `;
    expect(tagsOf(src)).toEqual([]);
  });

  it('skip·todo·only를 구분한다', () => {
    const found = scan(`
      it.skip('[AC-ROOM-001-1] a', () => {});
      it.todo('[AC-ROOM-001-2] b');
      test.skipIf(true)('[AC-TXN-001-1] c', () => {});
      it.only('[AC-REF-001-1] d', () => {});
      it('[AC-ROOM-001-12] e', () => {});
    `);
    expect(found.map((f) => [f.id, f.skipped, f.only])).toEqual([
      ['AC-ROOM-001-1', true, false],
      ['AC-ROOM-001-2', true, false],
      ['AC-TXN-001-1', true, false],
      ['AC-REF-001-1', false, true],
      ['AC-ROOM-001-12', false, false],
    ]);
  });

  it('태그 없는 .only도 잡는다', () => {
    expect(scan(`it.only('no tag', () => {})`)).toEqual([
      { id: undefined, file: 'x.spec.ts', line: 1, skipped: false, only: true },
    ]);
  });
});

describe('AC 검사 스크립트: 판정', () => {
  it('필수 AC(BE·BE+FE·참조)에 시험이 없으면 실패한다. FE는 필수가 아니다', () => {
    const r = evaluate({ rows, tags: [] });
    expect(r.ok).toBe(false);
    expect(r.required).toBe(4);
    expect(r.missing.map((m) => m.id)).toEqual([
      'AC-ROOM-001-1',
      'AC-ROOM-001-2',
      'AC-TXN-001-1',
      'AC-REF-001-1',
    ]);
  });

  it('필수 AC마다 시험이 있으면 통과한다', () => {
    const tags = scan(`
      it('[AC-ROOM-001-1][AC-ROOM-001-2] a', () => {});
      it('[AC-TXN-001-1][AC-REF-001-1] b', () => {});
    `);
    expect(evaluate({ rows, tags })).toMatchObject({
      ok: true,
      required: 4,
      covered: 4,
      missing: [],
    });
  });

  it('skip·todo 시험만 있는 AC는 누락으로 센다', () => {
    const tags = scan(`
      it('[AC-ROOM-001-1] a', () => {});
      it.skip('[AC-ROOM-001-2] b', () => {});
      it('[AC-TXN-001-1][AC-REF-001-1] c', () => {});
    `);
    const r = evaluate({ rows, tags });
    expect(r.ok).toBe(false);
    expect(r.missing).toMatchObject([{ id: 'AC-ROOM-001-2', skipped: true }]);
  });

  it('표에 없는 태그, FE 전용 AC 태그, .only는 실패다', () => {
    const tags = scan(`
      it('[AC-ROOM-001-1][AC-ROOM-001-2][AC-TXN-001-1][AC-REF-001-1] all', () => {});
      it('[AC-NOPE-999-9] typo', () => {});
      it('[AC-ROOM-001-12] fe', () => {});
      it.only('x', () => {});
    `);
    const r = evaluate({ rows, tags });
    expect(r.missing).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.kind).sort()).toEqual(['fe-only-tag', 'only', 'unknown-tag']);
  });

  it('--task는 담당 Task 토큰이 정확히 같은 행만 본다(BE-S2-2는 BE-S2-20과 다르다)', () => {
    const tags = scan(`it('[AC-TXN-001-1] a', () => {});`);
    expect(evaluate({ rows, tags, task: 'BE-S2-2' })).toMatchObject({ ok: true, required: 1 });
    expect(evaluate({ rows, tags, task: 'BE-S2-20' })).toMatchObject({ ok: false, required: 1 });
    expect(evaluate({ rows, tags, task: 'BE-S1-2' })).toMatchObject({ ok: false, required: 2 });
  });

  it('--spec은 Spec 행만 본다', () => {
    expect(evaluate({ rows, tags: [], spec: 'S2' }).required).toBe(2);
  });

  it('results 모드: 통과한 태그 시험만 덮고 실패한 태그 시험은 실패다', () => {
    const json = {
      testResults: [
        {
          name: 'a.spec.ts',
          assertionResults: [
            { fullName: '[AC-ROOM-001-1] a', title: '[AC-ROOM-001-1] a', status: 'passed' },
            { fullName: '[AC-ROOM-001-2] b', title: '[AC-ROOM-001-2] b', status: 'failed' },
            { fullName: '[AC-TXN-001-1] c', title: '[AC-TXN-001-1] c', status: 'skipped' },
            { fullName: '[AC-REF-001-1] d', title: '[AC-REF-001-1] d', status: 'passed' },
          ],
        },
      ],
    };
    const r = evaluate({ rows, tags: [], results: tagsFromResults(json) });
    expect(r.ok).toBe(false);
    expect(r.missing.map((m) => m.id)).toEqual(['AC-ROOM-001-2', 'AC-TXN-001-1']);
    expect(r.problems).toEqual([{ kind: 'failed-test', id: 'AC-ROOM-001-2' }]);
  });
});

describe('AC 검사 스크립트: 실행(종료 코드)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'f8-ac-'));
  const matrix = join(dir, 'matrix.md');
  const missingTests = join(dir, 'missing');
  const fullTests = join(dir, 'full');
  writeFileSync(matrix, MATRIX);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function writeTests(where: string, body: string) {
    spawnSync('mkdir', ['-p', where]);
    writeFileSync(join(where, 'a.spec.ts'), body);
  }

  it('run(): 누락 AC가 있으면 1을 돌려주고 누락을 출력한다', () => {
    writeTests(missingTests, `it('[AC-ROOM-001-1] only one', () => {});`);
    const out: string[] = [];
    expect(run(['--file', matrix, '--tests', missingTests], { out: (s) => out.push(s) })).toBe(1);
    expect(out.join('\n')).toContain('누락 AC-ROOM-001-2');
    expect(out.join('\n')).toContain('결과: 실패');
  });

  it('run(): 모두 있으면 0이다', () => {
    writeTests(
      fullTests,
      `it('[AC-ROOM-001-1][AC-ROOM-001-2][AC-TXN-001-1][AC-REF-001-1] all', () => {});`,
    );
    expect(run(['--file', matrix, '--tests', fullTests], { out: () => undefined })).toBe(0);
  });

  it('CLI: 실제 프로세스가 누락이면 종료 코드 1, 모두 있으면 0, 잘못된 옵션은 2', () => {
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, ['scripts/ac-check.mjs', ...args], { encoding: 'utf8' });
    const bad = cli('--file', matrix, '--tests', missingTests);
    expect(bad.status).toBe(1);
    expect(bad.stdout).toContain('누락 AC-TXN-001-1');
    expect(cli('--file', matrix, '--tests', fullTests).status).toBe(0);
    expect(cli('--bogus').status).toBe(2);
    expect(cli('--file', join(dir, 'nope.md')).status).toBe(2);
  });
});
