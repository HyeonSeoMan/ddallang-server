export interface MatrixRow {
  id: string;
  spec: string;
  kind: string;
  task: string;
}
export interface ScannedTag {
  id: string | undefined;
  file: string;
  line: number;
  skipped: boolean;
  only: boolean;
}
export interface ResultTag {
  id: string;
  file: string;
  status: string;
}
export interface EvalResult {
  totalRows: number;
  required: number;
  covered: number;
  missing: (MatrixRow & { skipped: boolean })[];
  problems: { kind: string; id?: string; file?: string; line?: number }[];
  ok: boolean;
}
export function parseMatrix(markdown: string): { rows: MatrixRow[]; version: string };
export function scanTestSource(path: string, text: string): ScannedTag[];
export function collectTestFiles(root: string): string[];
export function tagsFromResults(json: unknown): ResultTag[];
export function resultsHealth(json: unknown): {
  failedTests: number;
  failedSuites: number;
  ok: boolean;
};
export function evaluate(args: {
  rows: MatrixRow[];
  tags: ScannedTag[];
  results?: ResultTag[];
  task?: string;
  spec?: string;
  health?: { failedTests: number; failedSuites: number; ok: boolean };
  allowEmpty?: boolean;
}): EvalResult;
export function run(argv: string[], io?: { out: (s: string) => void }): number;
