import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {analyzeSource, type FileAnalysis} from './analyze.js';

export {analyzeSource, normalizeJsxText} from './analyze.js';
export type {Candidate, FileAnalysis, Usage} from './analyze.js';
export {applyEdits, deriveNamespace, instrumentFile, keyFromText} from './instrument.js';
export type {Edit, FileEdits, PlannedMessage} from './instrument.js';

export async function analyzeFile(root: string, rel: string): Promise<{analysis: FileAnalysis; text: string}> {
  const text = await readFile(path.join(root, rel), 'utf8');
  return {analysis: analyzeSource(rel, text), text};
}
