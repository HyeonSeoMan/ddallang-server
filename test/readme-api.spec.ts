import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootTestApp, type TestApp } from './helpers/app.js';
import { collectControllerRoutes } from './helpers/route-parity.js';

let t: TestApp;
beforeAll(async () => {
  t = await bootTestApp();
});
afterAll(() => t?.close());

/** README의 "구현된 API" 표에서 `METHOD /path` 항목을 읽는다(`{param}` 표기). */
function readmeRoutes(): Set<string> {
  const text = readFileSync('README.md', 'utf8');
  const section = text.slice(text.indexOf('### 구현된 API'), text.indexOf('## 시작하기'));
  const out = new Set<string>();
  for (const m of section.matchAll(/^\|\s*`([A-Z]+) (\/[^`]*)`/gm)) out.add(`${m[1]} ${m[2]}`);
  return out;
}

describe('README의 구현된 API 표', () => {
  it('실제로 구현된 엔드포인트(컨트롤러)와 정확히 일치한다: 추가·삭제를 놓치지 않는다', () => {
    const documented = readmeRoutes();
    const implemented = collectControllerRoutes(t.app);
    expect([...documented].sort()).toEqual([...implemented].sort());
  });
});
