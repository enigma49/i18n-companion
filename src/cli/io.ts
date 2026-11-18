import {parseArgs} from 'node:util';
import path from 'node:path';
import {CompanionError, diag, type Diagnostic} from '../core/diagnostics.js';

/** Every flag any command accepts. Commands read only the ones they document. */
const OPTIONS = {
  json: {type: 'boolean'},
  cwd: {type: 'string'},
  help: {type: 'boolean', short: 'h'},
  version: {type: 'boolean', short: 'v'},
  yes: {type: 'boolean', short: 'y'},
  'dry-run': {type: 'boolean'},
  assistant: {type: 'string'},
  source: {type: 'string'},
  targets: {type: 'string'},
  mode: {type: 'string'},
  rule: {type: 'boolean'},
  mcp: {type: 'boolean'},
  code: {type: 'boolean'},
  apply: {type: 'boolean'},
  paths: {type: 'string', multiple: true},
  files: {type: 'string', multiple: true},
  locales: {type: 'string'},
  plan: {type: 'string'},
  size: {type: 'string'},
  input: {type: 'string'},
  changed: {type: 'boolean'},
  base: {type: 'string'},
  'accept-proposal': {type: 'boolean'},
  'reject-proposal': {type: 'boolean'},
  debounce: {type: 'string'},
} as const;

export type Flags = {
  json?: boolean;
  cwd?: string;
  help?: boolean;
  version?: boolean;
  yes?: boolean;
  'dry-run'?: boolean;
  assistant?: string;
  source?: string;
  targets?: string;
  mode?: string;
  rule?: boolean;
  mcp?: boolean;
  code?: boolean;
  apply?: boolean;
  paths?: string[];
  files?: string[];
  locales?: string;
  plan?: string;
  size?: string;
  input?: string;
  changed?: boolean;
  base?: string;
  'accept-proposal'?: boolean;
  'reject-proposal'?: boolean;
  debounce?: string;
};

export interface Context {
  command: string | undefined;
  positionals: string[];
  flags: Flags;
  root: string;
  json: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
}

export function usageError(message: string): CompanionError {
  return new CompanionError(diag('I18N_CONFIG_INVALID', 'error', message, {hint: 'Run `i18n-companion --help`.'}), 2);
}

export function parseCli(argv: string[], io: {out: (t: string) => void; err: (t: string) => void}): Context {
  let parsed;
  try {
    parsed = parseArgs({args: argv, options: OPTIONS, allowPositionals: true, allowNegative: true, strict: true});
  } catch (error) {
    throw usageError((error as Error).message);
  }
  const [command, ...positionals] = parsed.positionals;
  const flags = parsed.values as Flags;
  return {command, positionals, flags, root: path.resolve(flags.cwd ?? process.cwd()), json: Boolean(flags.json), ...io};
}

/** Splits repeated and comma-separated values: `--paths a,b --paths c` → [a, b, c]. */
export function list(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const items = (Array.isArray(value) ? value : [value]).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

export function intFlag(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw usageError(`--${name} must be a positive whole number.`);
  return n;
}

export function formatDiagnostic(d: Diagnostic): string {
  const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ''} ` : d.id ? `${d.id}${d.locale ? ` (${d.locale})` : ''} ` : '';
  return `  ${d.severity.padEnd(7)} ${d.code}  ${where}${d.message}${d.hint ? `\n          → ${d.hint}` : ''}`;
}

export function formatDiagnostics(list: readonly Diagnostic[], limit = 50): string {
  if (!list.length) return '';
  const shown = list.slice(0, limit).map(formatDiagnostic);
  if (list.length > limit) shown.push(`  … and ${list.length - limit} more (use --json for all)`);
  return shown.join('\n');
}

/** Prints JSON in --json mode, otherwise the human text. */
export function emit(ctx: Context, data: unknown, human: () => string): void {
  if (ctx.json) ctx.out(JSON.stringify(data, null, 2));
  else {
    const text = human();
    if (text) ctx.out(text);
  }
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}
