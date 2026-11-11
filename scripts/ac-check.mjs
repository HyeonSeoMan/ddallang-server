#!/usr/bin/env node
// BE-F8: ac-matrix.md의 백엔드 담당 AC마다 `[AC-…]` 태그가 달린 시험이 있는지 검사한다(plan §8).
// 매핑표는 이 저장소에 복사하지 않고 ddallang의 git 참조(기본 origin/main)에서 읽는다.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const ts = require('typescript');

const AC_ID = /AC-[A-Z]+-\d{3}-\d+/g;
const TEST_BASES = new Set(['it', 'test', 'describe']);
const SKIP_MODS = new Set(['skip', 'todo', 'skipIf', 'runIf']);
const REQUIRED_KINDS = new Set(['BE', 'BE+FE', '참조']);

/** 마크다운 표에서 AC 행을 읽는다. 구분: BE · BE+FE · FE · 참조 */
export function parseMatrix(markdown) {
  const rows = [];
  let version = '';
  for (const line of markdown.split('\n')) {
    if (!version && line.includes('문서 버전')) version = line.replace(/^-\s*/, '').slice(0, 120);
    if (!/^\|\s*AC-/.test(line)) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 4) continue;
    rows.push({ id: cells[0], spec: cells[1], kind: cells[2], task: cells[3] });
  }
  return { rows, version };
}

function chainOf(expr) {
  // `it.skip`, `test.each(table)`, `it.skipIf(cond)` 같은 호출 대상에서 기본 식별자와 수식어를 모은다.
  const mods = [];
  let cur = expr;
  for (;;) {
    if (ts.isCallExpression(cur)) cur = cur.expression;
    else if (ts.isPropertyAccessExpression(cur)) {
      mods.push(cur.name.text);
      cur = cur.expression;
    } else break;
  }
  return ts.isIdentifier(cur) ? { base: cur.text, mods } : undefined;
}

function tagsFromTitle(arg) {
  if (!arg) return [];
  if (ts.isStringLiteralLike(arg))
    return [...arg.text.matchAll(/\[(AC-[A-Z]+-\d{3}-\d+)\]/g)].map((m) => m[1]);
  if (ts.isTemplateExpression(arg)) {
    // 치환(${…})을 가로지르는 조각을 이어 붙이면 실행 때 없는 제목이 생기므로 리터럴 조각마다 따로 본다.
    const segments = [arg.head.text, ...arg.templateSpans.map((sp) => sp.literal.text)];
    return segments.flatMap((seg) =>
      [...seg.matchAll(/\[(AC-[A-Z]+-\d{3}-\d+)\]/g)].map((m) => m[1]),
    );
  }
  // 도우미: ac('AC-…' | ['AC-…'], 'S1 §3.2', '제목')
  if (ts.isCallExpression(arg) && ts.isIdentifier(arg.expression) && arg.expression.text === 'ac') {
    const first = arg.arguments[0];
    if (!first) return [];
    const lits = ts.isArrayLiteralExpression(first) ? first.elements : [first];
    return lits.filter((e) => ts.isStringLiteralLike(e)).flatMap((e) => e.text.match(AC_ID) ?? []);
  }
  return [];
}

function isEmptyEach(callee) {
  // it.each([])('…') : 호출 대상이 `it.each(<빈 배열 리터럴>)`이면 시험 사례가 0개다.
  return (
    ts.isCallExpression(callee) &&
    ts.isPropertyAccessExpression(callee.expression) &&
    callee.expression.name.text === 'each' &&
    callee.arguments[0] !== undefined &&
    ts.isArrayLiteralExpression(callee.arguments[0]) &&
    callee.arguments[0].elements.length === 0
  );
}

/**
 * 시험 파일 하나에서 제목 태그를 모은다. 주석·시험 본문 안의 문자열은 세지 않는다.
 * 태그가 "덮는다"고 보려면 실제로 실행될 시험 사례가 있어야 한다:
 * - skip/todo/skipIf가 붙었거나, 그런 조상(describe.skip 등) 안에 있거나, 빈 it.each이면 덮지 않는다.
 * - describe의 태그는 그 안에 실행될 시험 사례가 하나 이상 있을 때만 덮는다.
 */
export function scanTestSource(path, text) {
  const entries = [];
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
  const visit = (node, ancestors) => {
    let nextAncestors = ancestors;
    if (ts.isCallExpression(node)) {
      const chain = chainOf(node.expression);
      if (chain && TEST_BASES.has(chain.base)) {
        const tags = tagsFromTitle(node.arguments[0]);
        const only = chain.mods.includes('only');
        const dead = chain.mods.some((m) => SKIP_MODS.has(m)) || isEmptyEach(node.expression);
        const isSuite = chain.base === 'describe';
        const entry = {
          tags,
          only,
          isSuite,
          dead,
          cases: 0,
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          effectivelyDead: dead || ancestors.some((a) => a.effectivelyDead),
        };
        if (!isSuite && !entry.effectivelyDead) for (const a of ancestors) a.cases++;
        if (tags.length > 0 || only) entries.push(entry);
        nextAncestors = [...ancestors, entry];
      }
    }
    ts.forEachChild(node, (child) => visit(child, nextAncestors));
  };
  visit(source, []);

  const found = [];
  for (const e of entries) {
    const covers = !e.effectivelyDead && (!e.isSuite || e.cases > 0);
    for (const id of e.tags.length > 0 ? e.tags : [undefined]) {
      found.push({ id, file: path, line: e.line, skipped: !covers, only: e.only });
    }
  }
  return found;
}

export function collectTestFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(spec|test)\.ts$/.test(name)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** vitest JSON 보고서에서 태그별 통과·실패 개수를 센다. */
export function tagsFromResults(json) {
  const out = [];
  for (const file of json.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      const title = `${t.fullName ?? ''} ${t.title ?? ''}`;
      for (const m of new Set([...title.matchAll(/\[(AC-[A-Z]+-\d{3}-\d+)\]/g)].map((x) => x[1]))) {
        out.push({ id: m, file: file.name, status: t.status });
      }
    }
  }
  return out;
}

/** vitest JSON 보고서 전체의 건강 상태: 태그 없는 시험·스위트 실패도 잡는다. */
export function resultsHealth(json) {
  let failedTests = 0;
  let failedSuites = 0;
  for (const f of json.testResults ?? []) {
    const cases = f.assertionResults ?? [];
    failedTests += cases.filter((t) => t.status === 'failed').length;
    if (f.status === 'failed' && !cases.some((t) => t.status === 'failed')) failedSuites++;
  }
  return {
    failedTests,
    failedSuites,
    ok: json.success !== false && failedTests === 0 && failedSuites === 0,
  };
}

function matchesTask(cell, task) {
  const esc = task.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9-])${esc}($|[^A-Za-z0-9-])`).test(cell);
}

/**
 * 판정. static: 제목에 태그가 있고 skip/todo가 아닌 시험이 있으면 덮인 것으로 본다.
 * results: 태그가 달린 시험이 실제로 통과했을 때만 덮인 것이고, 실패한 태그 시험이 있으면 실패다.
 */
export function evaluate({ rows, tags, results, task, spec, health, allowEmpty }) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const problems = [];
  const covered = new Set();
  const skippedOnly = new Set();

  if (results) {
    const passed = new Set();
    const failed = new Set();
    for (const t of results) {
      if (t.status === 'passed') passed.add(t.id);
      else if (t.status === 'failed') failed.add(t.id);
      else skippedOnly.add(t.id);
    }
    for (const id of passed) if (!failed.has(id)) covered.add(id);
    for (const id of failed) problems.push({ kind: 'failed-test', id });
  } else {
    for (const t of tags) {
      if (t.only) problems.push({ kind: 'only', file: t.file, line: t.line });
      if (!t.id) continue;
      if (t.skipped) skippedOnly.add(t.id);
      else covered.add(t.id);
    }
  }
  const seenIds = new Set([...(results ?? tags).map((t) => t.id).filter(Boolean)]);
  for (const id of seenIds) {
    const row = byId.get(id);
    if (!row) problems.push({ kind: 'unknown-tag', id });
    else if (row.kind === 'FE') problems.push({ kind: 'fe-only-tag', id });
  }

  let required = rows.filter((r) => REQUIRED_KINDS.has(r.kind));
  if (task) required = required.filter((r) => matchesTask(r.task, task));
  if (spec) required = required.filter((r) => r.spec === spec);
  if ((task || spec) && required.length === 0 && !allowEmpty) {
    problems.push({ kind: 'empty-filter' });
  }
  if (health && !health.ok) {
    problems.push({
      kind: 'test-run-failed',
      failedTests: health.failedTests,
      failedSuites: health.failedSuites,
    });
  }
  const missing = required
    .filter((r) => !covered.has(r.id))
    .map((r) => ({ ...r, skipped: skippedOnly.has(r.id) }));

  return {
    totalRows: rows.length,
    required: required.length,
    covered: required.length - missing.length,
    missing,
    problems,
    ok: missing.length === 0 && problems.length === 0,
  };
}

function readMatrix(opts) {
  if (opts.file) return { text: readFileSync(opts.file, 'utf8'), source: opts.file };
  const repo = resolve(opts.repo);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const sha = git('rev-parse', opts.ref).trim();
  return {
    text: git('show', `${opts.ref}:${opts.path}`),
    source: `${repo} ${opts.ref}@${sha.slice(0, 7)}:${opts.path}`,
  };
}

function parseArgs(argv) {
  const opts = {
    repo: process.env.DDALLANG_REPO ?? '../ddallang',
    ref: 'origin/main',
    path: 'docs/plans/server/ac-matrix.md',
    tests: 'test',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 값이 없다`);
      return v;
    };
    if (a === '--repo') opts.repo = next();
    else if (a === '--ref') opts.ref = next();
    else if (a === '--path') opts.path = next();
    else if (a === '--file') opts.file = next();
    else if (a === '--tests') opts.tests = next();
    else if (a === '--task') opts.task = next();
    else if (a === '--spec') opts.spec = next();
    else if (a === '--results') opts.results = next();
    else if (a === '--allow-empty') opts.allowEmpty = true;
    else throw new Error(`알 수 없는 옵션: ${a}`);
  }
  return opts;
}

export function run(argv, io = { out: (s) => console.log(s) }) {
  const opts = parseArgs(argv);
  const { text, source } = readMatrix(opts);
  const { rows, version } = parseMatrix(text);
  if (rows.length === 0) throw new Error('매핑표에서 AC 행을 하나도 읽지 못했다');
  const files = collectTestFiles(opts.tests);
  const tags = files.flatMap((f) =>
    scanTestSource(relative(process.cwd(), f), readFileSync(f, 'utf8')),
  );
  const resultsJson = opts.results ? JSON.parse(readFileSync(opts.results, 'utf8')) : undefined;
  const results = resultsJson ? tagsFromResults(resultsJson) : undefined;
  const health = resultsJson ? resultsHealth(resultsJson) : undefined;
  const r = evaluate({
    rows,
    tags,
    results,
    task: opts.task,
    spec: opts.spec,
    health,
    allowEmpty: opts.allowEmpty,
  });

  const kinds = rows.reduce((m, x) => ((m[x.kind] = (m[x.kind] ?? 0) + 1), m), {});
  io.out(`매핑표: ${source}`);
  io.out(`문서: ${version}`);
  io.out(
    `행 ${r.totalRows}개 (${Object.entries(kinds)
      .map(([k, v]) => `${k} ${v}`)
      .join(
        ', ',
      )}), 모드: ${results ? 'results(통과 확인)' : 'static(태그 존재)'}${opts.task ? `, task=${opts.task}` : ''}${opts.spec ? `, spec=${opts.spec}` : ''}`,
  );
  io.out(`필수 ${r.required}개 중 시험 있음 ${r.covered}개, 없음 ${r.missing.length}개`);
  for (const m of r.missing)
    io.out(
      `  누락 ${m.id} (${m.spec}, ${m.task})${m.skipped ? ' [skip/todo/미통과 시험만 있음]' : ''}`,
    );
  for (const p of r.problems) {
    if (p.kind === 'unknown-tag') io.out(`  오류 표에 없는 태그: ${p.id}`);
    else if (p.kind === 'fe-only-tag') io.out(`  오류 FE 전용 AC에 백엔드 시험 태그: ${p.id}`);
    else if (p.kind === 'only') io.out(`  오류 .only 시험: ${p.file}:${p.line}`);
    else if (p.kind === 'failed-test') io.out(`  오류 실패한 태그 시험: ${p.id}`);
    else if (p.kind === 'empty-filter')
      io.out(
        '  오류 --task/--spec에 해당하는 필수 AC 행이 없다(오타이거나 AC가 없는 기반 Task면 --allow-empty)',
      );
    else if (p.kind === 'test-run-failed')
      io.out(
        `  오류 시험 실행 실패: 실패 시험 ${p.failedTests}개, 실패 스위트 ${p.failedSuites}개(태그 없는 시험 포함)`,
      );
  }
  io.out(r.ok ? '결과: 통과' : '결과: 실패');
  return r.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(run(process.argv.slice(2)));
  } catch (err) {
    console.error(`ac-check 오류: ${err.message}`);
    process.exit(2);
  }
}
