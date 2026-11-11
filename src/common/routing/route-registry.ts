import { Inject, Injectable, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { ModulesContainer } from '@nestjs/core';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Env } from '../config/env.js';
import { ENV } from '../config/env.token.js';
import { ApiError } from '../errors/api-error.js';

export interface RouteEntry {
  /** Express 형식 경로 패턴: 정적 경로, `:param`, 끝의 `*` */
  pattern: string;
  /** 허용 메서드(대문자). 목록에 없는 메서드는 `405`다(HEAD·OPTIONS도 예외가 아니다). */
  methods: string[];
}

const ALL_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];

/**
 * 비-Spec 경로(Spec의 "정의되지 않은 경로는 404"에 대한 사용자 승인 예외)를 명시 등록한다.
 * `/health`(PD-20)와, 켜진 경우에만 Swagger 경로(PD-19)이며 모두 `GET` 전용이다.
 */
export function nonSpecRoutes(env: Pick<Env, 'NODE_ENV'>): RouteEntry[] {
  const routes: RouteEntry[] = [{ pattern: '/health', methods: ['GET'] }];
  if (env.NODE_ENV === 'development') {
    routes.push(
      { pattern: '/api-docs', methods: ['GET'] },
      { pattern: '/api-docs/*', methods: ['GET'] }, // UI 자원
      { pattern: '/api-docs-json', methods: ['GET'] },
    );
  }
  return routes;
}

const joinPath = (...parts: string[]): string =>
  '/' +
  parts
    .map((s) => s.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [''];
  return Array.isArray(value) ? value : [value];
}

function methodNames(method: number): string[] {
  return method === RequestMethod.ALL ? ALL_METHODS : [RequestMethod[method]!];
}

/**
 * 경로 매개변수 형식 제약. 서버가 만드는 거래 ID는 22자 base64url이다. `POST …/transactions/batch` 같은
 * 일괄 등록·정정 경로는 정의하지 않으므로 404여야 하는데(S2 §4.4), 제약이 없으면 `batch`가 거래 ID로 매칭되어
 * 405가 된다. 그래서 ID 모양이 아닌 값은 그 경로가 없는 것으로 판정한다.
 */
export const PARAM_CONSTRAINTS: Record<string, string> = {
  transactionId: '[A-Za-z0-9_-]{22}',
};

/** 패턴을 Express와 같은 규칙(대소문자 무시, 끝 슬래시 허용)의 정규식으로 바꾼다. */
export function compilePattern(pattern: string): RegExp {
  const body = pattern
    .split('/')
    .map((seg) => {
      if (seg === '*') return '.*';
      if (seg.startsWith(':')) return PARAM_CONSTRAINTS[seg.slice(1)] ?? '[^/]+';
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${body}/?$`, 'i');
}

/**
 * 라우트 레지스트리(PD-9): 컨트롤러가 정의한 (경로, 메서드)와 비-Spec 항목에서 만든다. 미들웨어는
 * 인증보다, Swagger 라우트·Nest 라우터보다 먼저 실행되어 `404 ROUTE_NOT_FOUND`·`405 NOT_SUPPORTED`+`Allow`를
 * 판정한다. 방·참여자 존재와 인증 여부를 조회하지 않으므로 어떤 정보도 드러내지 않는다.
 * 첫 요청 때 한 번 만든다(그 시점에 모든 컨트롤러가 등록되어 있다).
 */
@Injectable()
export class RouteRegistry {
  private compiled?: { regex: RegExp; methods: string[] }[];
  private cachedEntries?: RouteEntry[];

  constructor(
    private readonly modules: ModulesContainer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  entries(): RouteEntry[] {
    this.cachedEntries ??= this.build();
    return this.cachedEntries;
  }

  /** `"GET /health"` 형식의 (메서드, 경로) 집합. */
  routeKeys(): Set<string> {
    return new Set(this.entries().flatMap((e) => e.methods.map((m) => `${m} ${e.pattern}`)));
  }

  middleware(): RequestHandler {
    return (req: Request, res: Response, next: NextFunction) => {
      const error = this.judge(req.path, req.method);
      if (!error) return next();
      for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
      res.status(error.status).json(error.toBody());
    };
  }

  /** 허용이면 `undefined`, 아니면 응답할 오류. */
  judge(path: string, method: string): ApiError | undefined {
    this.compiled ??= this.entries().map((e) => ({
      regex: compilePattern(e.pattern),
      methods: e.methods,
    }));
    const matched = this.compiled.filter((c) => c.regex.test(path));
    if (matched.length === 0) return new ApiError('ROUTE_NOT_FOUND');
    const allowed = new Set(matched.flatMap((m) => m.methods));
    if (allowed.has(method.toUpperCase())) return undefined;
    return new ApiError('NOT_SUPPORTED', { headers: { Allow: [...allowed].sort().join(', ') } });
  }

  private build(): RouteEntry[] {
    const byPattern = new Map<string, Set<string>>();
    const add = (pattern: string, methods: string[]) => {
      const set = byPattern.get(pattern) ?? new Set<string>();
      methods.forEach((m) => set.add(m));
      byPattern.set(pattern, set);
    };
    for (const mod of this.modules.values()) {
      for (const wrapper of mod.controllers.values()) {
        const ctrl = wrapper.metatype as (new (...args: never[]) => object) | null;
        if (!ctrl) continue;
        const bases = asArray(
          Reflect.getMetadata(PATH_METADATA, ctrl) as string | string[] | undefined,
        );
        for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
          const handler = (ctrl.prototype as Record<string, unknown>)[name];
          if (typeof handler !== 'function') continue;
          const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
          if (method === undefined) continue;
          const subs = asArray(
            Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined,
          );
          for (const b of bases) for (const s of subs) add(joinPath(b, s), methodNames(method));
        }
      }
    }
    for (const r of nonSpecRoutes(this.env)) add(r.pattern, r.methods);
    return [...byPattern].map(([pattern, methods]) => ({ pattern, methods: [...methods].sort() }));
  }
}
