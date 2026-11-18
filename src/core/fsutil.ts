import {existsSync} from 'node:fs';
import {copyFile, glob, mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {sha256} from './hash.js';

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

export async function fileHash(file: string): Promise<string | null> {
  if (!existsSync(file)) return null;
  return sha256(await readFile(file, 'utf8'));
}

/** Writes through a temp file and a rename, so a crash never leaves a half-written file. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await mkdir(path.dirname(file), {recursive: true});
  const tmp = `${file}.i18n-companion-tmp-${process.pid}`;
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, file);
}

export interface PendingWrite {
  file: string;
  data: string;
}

/**
 * Writes several files as one unit. Every target is backed up first; if any write fails, every
 * file already written is restored and new files are removed. The backup folder is kept until
 * the next successful transaction so a person can recover by hand if the process is killed.
 */
export async function writeTransaction(writes: PendingWrite[], backupDir: string): Promise<void> {
  await rm(backupDir, {recursive: true, force: true});
  await mkdir(backupDir, {recursive: true});
  const manifest: {file: string; backup: string | null}[] = [];
  for (const [i, w] of writes.entries()) {
    if (existsSync(w.file)) {
      const backup = path.join(backupDir, `${i}-${path.basename(w.file)}`);
      await copyFile(w.file, backup);
      manifest.push({file: w.file, backup});
    } else {
      manifest.push({file: w.file, backup: null});
    }
  }
  await writeFile(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const done: number[] = [];
  try {
    for (const [i, w] of writes.entries()) {
      await writeFileAtomic(w.file, w.data);
      done.push(i);
    }
  } catch (error) {
    for (const i of done.reverse()) {
      const m = manifest[i]!;
      if (m.backup) await copyFile(m.backup, m.file);
      else await rm(m.file, {force: true});
    }
    throw error;
  }
  await rm(backupDir, {recursive: true, force: true});
}

/** Lists project files matching include globs and not matching exclude globs. */
export async function listFiles(root: string, include: string[], exclude: string[]): Promise<string[]> {
  const always = ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/.git/**', '**/.i18n-companion/**'];
  const excludes = [...always, ...exclude];
  const out = new Set<string>();
  for (const pattern of include) {
    for await (const entry of glob(pattern, {cwd: root, exclude: (p) => excludes.some((g) => path.matchesGlob(toPosix(p), g))})) {
      const rel = toPosix(entry);
      if (excludes.some((g) => path.matchesGlob(rel, g))) continue;
      out.add(rel);
    }
  }
  return [...out].sort();
}

export function matchesAny(rel: string, globs: string[]): boolean {
  return globs.some((g) => path.matchesGlob(toPosix(rel), g) || path.matchesGlob(toPosix(rel), `${g.replace(/\/$/, '')}/**`));
}
