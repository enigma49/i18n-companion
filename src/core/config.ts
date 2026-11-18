import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import {z} from 'zod';
import {CompanionError, diag} from './diagnostics.js';

export const CONFIG_FILES = [
  'i18n-companion.config.ts',
  'i18n-companion.config.mjs',
  'i18n-companion.config.js',
  'i18n-companion.config.json',
] as const;

/** Where the tool keeps its own state inside a project. */
export const STATE_DIR = '.i18n-companion';
export const WORK_DIR = path.join(STATE_DIR, 'work');
export const REGISTRY_FILE = path.join(STATE_DIR, 'registry.json');
export const INSTALL_FILE = path.join(STATE_DIR, 'install.json');

function isValidLocale(tag: string): boolean {
  try {
    return Intl.getCanonicalLocales(tag).length === 1;
  } catch {
    return false;
  }
}

const locale = z.string().refine(isValidLocale, {message: 'not a valid BCP 47 locale tag'});

const glossaryEntry = z.union([
  z.object({doNotTranslate: z.literal(true), note: z.string().optional()}),
  z.object({translations: z.record(z.string(), z.string()), note: z.string().optional()}),
]);

export const configSchema = z
  .object({
    sourceLocale: locale,
    targetLocales: z.array(locale).min(1),
    adapter: z.literal('next-intl'),
    messagesDir: z.string(),
    include: z.array(z.string()).min(1),
    exclude: z.array(z.string()).default([]),
    translation: z
      .object({
        mode: z.enum(['assistant', 'provider']).default('assistant'),
        provider: z
          .object({
            name: z.literal('anthropic'),
            model: z.string().optional(),
            apiKeyEnv: z.string().default('ANTHROPIC_API_KEY'),
            maxBatchSize: z.number().int().min(1).max(100).default(25),
          })
          .optional(),
      })
      .default({mode: 'assistant'}),
    reviewedTranslations: z.literal('preserve').default('preserve'),
    /** Names of package.json scripts. Never commands. */
    checks: z.array(z.string().regex(/^[\w:.-]+$/, 'must be a package.json script name')).default([]),
    /** Short description of the product, given to translators. */
    context: z.string().max(2000).optional(),
    glossary: z.record(z.string(), glossaryEntry).default({}),
    policy: z
      .object({
        /** Message-id prefixes whose translations must be reviewed by a person, per locale. */
        requireReview: z.array(z.object({ids: z.array(z.string()), locales: z.array(locale).optional()})).default([]),
        /** What makes `check` fail. */
        failOn: z
          .array(z.enum(['invalid', 'hardcoded', 'missing', 'stale', 'draft', 'orphan', 'review']))
          .default(['invalid', 'hardcoded', 'missing', 'review']),
      })
      .default({requireReview: [], failOn: ['invalid', 'hardcoded', 'missing', 'review']}),
  })
  .refine((c) => !c.targetLocales.includes(c.sourceLocale), {
    message: 'targetLocales must not include the sourceLocale',
    path: ['targetLocales'],
  });

export type CompanionConfig = z.output<typeof configSchema>;
export type CompanionConfigInput = z.input<typeof configSchema>;

export function findConfigFile(root: string): string | undefined {
  for (const name of CONFIG_FILES) {
    const file = path.join(root, name);
    if (existsSync(file)) return file;
  }
  return undefined;
}

/** Validates a raw config object. Throws CompanionError with a readable message. */
export function parseConfig(raw: unknown, file = 'config'): CompanionConfig {
  const result = configSchema.safeParse(raw);
  if (!result.success) {
    throw new CompanionError(
      diag('I18N_CONFIG_INVALID', 'error', `${path.basename(file)} is invalid:\n${z.prettifyError(result.error)}`, {
        file,
      }),
    );
  }
  return result.data;
}

/**
 * Loads the config. A .ts config is transpiled in memory; it must be a plain
 * `export default {...}` object with no imports, which keeps loading side-effect free.
 */
export async function loadConfig(root: string): Promise<{config: CompanionConfig; file: string}> {
  const file = findConfigFile(root);
  if (!file) {
    throw new CompanionError(
      diag('I18N_CONFIG_MISSING', 'error', 'No i18n-companion config found. Run `npx i18n-companion init` first.'),
    );
  }
  const text = await readFile(file, 'utf8');
  let raw: unknown;
  if (file.endsWith('.json')) {
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw new CompanionError(diag('I18N_CONFIG_INVALID', 'error', `${path.basename(file)} is not valid JSON: ${String(error)}`, {file}));
    }
  } else {
    if (/^\s*import\s/m.test(text) || /\brequire\(/.test(text)) {
      throw new CompanionError(
        diag('I18N_CONFIG_INVALID', 'error', `${path.basename(file)} must not import anything; export a plain object.`, {file}),
      );
    }
    const js = file.endsWith('.ts')
      ? ts.transpileModule(text, {compilerOptions: {module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022}}).outputText
      : text;
    try {
      const mod = (await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))) as {default?: unknown};
      raw = mod.default;
    } catch (error) {
      throw new CompanionError(diag('I18N_CONFIG_INVALID', 'error', `${path.basename(file)} could not be loaded: ${String(error)}`, {file}));
    }
  }
  return {config: parseConfig(raw, file), file};
}

export function renderConfigTs(config: CompanionConfigInput): string {
  return `// i18n-companion configuration. Docs: https://github.com/enigma49/i18n-companion
// Keep this a plain object with no imports.
export default ${JSON.stringify(config, null, 2).replace(/"([A-Za-z_][\w]*)":/g, '$1:')};
`;
}
