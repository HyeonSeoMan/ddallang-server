import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants.js';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core';

/** "METHOD /path" 형식. 경로 매개변수는 OpenAPI 표기({id})로 맞춘다. */
export type RouteKey = string;

const IGNORED_PREFIX = '/api-docs';

function join(...parts: string[]): string {
  const p =
    '/' +
    parts
      .map((s) => s.replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .join('/');
  return p.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function pathsOf(value: string | string[] | undefined): string[] {
  if (value === undefined) return [''];
  return Array.isArray(value) ? value : [value];
}

/** 앱에 실제로 정의된 컨트롤러의 (메서드, 경로) 집합. */
export function collectControllerRoutes(app: INestApplication): Set<RouteKey> {
  const out = new Set<RouteKey>();
  const container = app.get(ModulesContainer);
  for (const mod of container.values()) {
    for (const wrapper of mod.controllers.values()) {
      const ctrl = wrapper.metatype as (new (...a: never[]) => object) | null;
      if (!ctrl) continue;
      const base = pathsOf(Reflect.getMetadata(PATH_METADATA, ctrl));
      for (const name of Object.getOwnPropertyNames(ctrl.prototype)) {
        const handler = (ctrl.prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (method === undefined) continue;
        const sub = pathsOf(Reflect.getMetadata(PATH_METADATA, handler));
        for (const b of base) {
          for (const s of sub) {
            out.add(`${RequestMethod[method]} ${join(b, s)}`);
          }
        }
      }
    }
  }
  return filterIgnored(out);
}

/** OpenAPI 문서의 (메서드, 경로) 집합. */
export function collectDocumentRoutes(doc: {
  paths: Record<string, object | undefined>;
}): Set<RouteKey> {
  const out = new Set<RouteKey>();
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of Object.keys(item ?? {})) {
      out.add(`${method.toUpperCase()} ${join(path)}`);
    }
  }
  return filterIgnored(out);
}

function filterIgnored(routes: Set<RouteKey>): Set<RouteKey> {
  return new Set([...routes].filter((r) => !r.split(' ')[1]?.startsWith(IGNORED_PREFIX)));
}

export interface RouteDiff {
  /** 컨트롤러에는 있으나 문서에 없다 */
  missingInDocument: RouteKey[];
  /** 문서에는 있으나 컨트롤러에 없다 */
  extraInDocument: RouteKey[];
}

export function diffRoutes(controllers: Set<RouteKey>, document: Set<RouteKey>): RouteDiff {
  return {
    missingInDocument: [...controllers].filter((r) => !document.has(r)).sort(),
    extraInDocument: [...document].filter((r) => !controllers.has(r)).sort(),
  };
}
