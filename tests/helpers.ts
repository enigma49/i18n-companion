import {cp, mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach} from 'vitest';
import type {BatchPayload, BatchResponse} from '../src/core/plan.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, {recursive: true, force: true});
});

/** Copies a fixture into a fresh temp folder, removed after the test. */
export async function useFixture(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), `i18nc-${name}-`));
  made.push(dir);
  await cp(path.join(FIXTURES, name), dir, {recursive: true});
  return dir;
}

/** Every file under a folder with its content, skipping the tool's own work folder. */
export async function snapshot(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(root, {recursive: true, withFileTypes: true})) {
    if (!entry.isFile()) continue;
    const rel = path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
    if (rel.startsWith('.i18n-companion/work/')) continue;
    out[rel] = await readFile(path.join(root, rel), 'utf8');
  }
  return out;
}

export async function readJson<T = Record<string, unknown>>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

/** A translator that keeps the ICU structure intact: it only tags the text with the locale. */
export function fakeTranslate(batch: BatchPayload): BatchResponse {
  return {
    batchId: batch.batchId!,
    translations: batch.items.map((i) => ({id: i.id, locale: batch.targetLocale!, sourceRevision: i.sourceRevision, text: `[${batch.targetLocale}] ${i.source}`})),
  };
}
