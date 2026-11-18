import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {applyChanges, planAssistantInstall, planUninstall, readManifest, writeManifest, type FileChange, type InstallManifest} from '../assistant/install.js';
import type {AssistantId} from '../assistant/templates.js';
import {findConfigFile, parseConfig, renderConfigTs, type CompanionConfigInput} from '../core/config.js';
import {defaultIncludes, detectProject, readPackageJson, type Detection} from '../core/detect.js';
import {loadProject, readState, saveRegistry} from '../core/project.js';
import {emit, formatDiagnostics, list, usageError, type Context} from './io.js';

const ASSISTANT_IDS: AssistantId[] = ['claude', 'codex', 'cursor', 'runbook'];
const GITIGNORE_LINE = '.i18n-companion/work/';
const CONFIG_NAME = 'i18n-companion.config.ts';
/** Package scripts worth running after a localization change, if the project has them. */
const CHECK_SCRIPTS = ['typecheck', 'lint', 'test'];

type Ask = (question: string, fallback: string) => Promise<string>;

function makeAsk(interactive: boolean): {ask: Ask; close: () => void} {
  if (!interactive) return {ask: async (_q, fallback) => fallback, close: () => {}};
  const rl = createInterface({input: process.stdin, output: process.stderr});
  return {
    ask: async (question, fallback) => (await rl.question(`${question}${fallback ? ` [${fallback}]` : ''}: `)).trim() || fallback,
    close: () => rl.close(),
  };
}

function describeChanges(changes: FileChange[]): string {
  return changes.map((c) => `  ${c.action.padEnd(6)} ${c.path}  (${c.description})`).join('\n');
}

async function gitignoreChange(root: string): Promise<FileChange | undefined> {
  const file = path.join(root, '.gitignore');
  const text = existsSync(file) ? await readFile(file, 'utf8') : undefined;
  if (text?.split(/\r?\n/).some((l) => l.trim() === GITIGNORE_LINE)) return undefined;
  const content = text === undefined ? `${GITIGNORE_LINE}\n` : `${text.replace(/\s*$/, '')}\n\n# i18n-companion plans and backups\n${GITIGNORE_LINE}\n`;
  return {path: '.gitignore', action: text === undefined ? 'create' : 'update', description: `adds ${GITIGNORE_LINE}`, content};
}

function mergeManifest(previous: InstallManifest | undefined, next: InstallManifest): InstallManifest {
  if (!previous) return next;
  const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];
  return {...next, owned: union(previous.owned, next.owned), blocks: union(previous.blocks, next.blocks), mcpEntries: union(previous.mcpEntries, next.mcpEntries)};
}

function refuseUnsupported(ctx: Context, detection: Detection): number {
  emit(ctx, {ok: false, support: detection.support, diagnostics: detection.diagnostics}, () =>
    [`This project is not ready for init (support: ${detection.support}). Nothing was changed.`, formatDiagnostics(detection.diagnostics)].join('\n'),
  );
  return 2;
}

export async function cmdInit(ctx: Context): Promise<number> {
  const {root, flags} = ctx;
  const detection = await detectProject(root);
  if (detection.support !== 'full') return refuseUnsupported(ctx, detection);

  const interactive = !flags.yes && !ctx.json && Boolean(process.stdin.isTTY);
  const {ask, close} = makeAsk(interactive);
  let assistant: string;
  let source: string;
  let targets: string[] | undefined;
  let mode: string;
  try {
    assistant = flags.assistant ?? (await ask(`Assistant (${ASSISTANT_IDS.join('/')})`, 'claude'));
    const detectedSource = detection.localesFound.includes('en') ? 'en' : (detection.localesFound[0] ?? 'en');
    source = flags.source ?? (await ask('Source locale', detectedSource));
    targets = list(flags.targets);
    if (!targets) {
      const guess = detection.localesFound.filter((l) => l !== source).join(',');
      targets = list(await ask('Target locales, comma separated', guess));
    }
    mode = flags.mode ?? (await ask('Translation mode (assistant/provider)', 'assistant'));
  } finally {
    close();
  }
  if (!ASSISTANT_IDS.includes(assistant as AssistantId)) throw usageError(`--assistant must be one of ${ASSISTANT_IDS.join(', ')}.`);
  if (mode !== 'assistant' && mode !== 'provider') throw usageError('--mode must be "assistant" or "provider".');
  if (!targets?.length) throw usageError('No target locales. Pass --targets, for example --targets fr,de.');

  const changes: FileChange[] = [];
  const existingConfig = findConfigFile(root);
  if (!existingConfig) {
    const pkg = await readPackageJson(root);
    const input: CompanionConfigInput = {
      sourceLocale: source,
      targetLocales: targets,
      adapter: 'next-intl',
      messagesDir: detection.messagesDir ?? 'messages',
      include: defaultIncludes(detection.framework.appDir),
      exclude: [],
      translation: mode === 'provider' ? {mode: 'provider', provider: {name: 'anthropic'}} : {mode: 'assistant'},
      checks: CHECK_SCRIPTS.filter((s) => pkg?.scripts?.[s]),
    };
    parseConfig(input, CONFIG_NAME);
    changes.push({path: CONFIG_NAME, action: 'create', description: 'configuration', content: renderConfigTs(input)});
  }
  const install = await planAssistantInstall(root, assistant as AssistantId, {rule: flags.rule ?? true, mcp: flags.mcp ?? true});
  changes.push(...install.changes);
  const ignore = await gitignoreChange(root);
  if (ignore) changes.push(ignore);

  const result = {
    ok: true,
    dryRun: Boolean(flags['dry-run']),
    keptExistingConfig: existingConfig ? path.basename(existingConfig) : undefined,
    changes: changes.map(({path: p, action, description}) => ({path: p, action, description})),
    registry: undefined as undefined | {messages: number; adoptedExisting: number},
  };
  if (!flags['dry-run']) {
    await applyChanges(root, changes);
    await writeManifest(root, mergeManifest(await readManifest(root), install.manifest));
    const project = await loadProject(root);
    const state = await readState(project);
    await saveRegistry(project, state.registry);
    result.registry = {messages: Object.keys(state.registry.messages).length, adoptedExisting: state.changes.adoptedExisting.length};
  }
  emit(ctx, result, () =>
    [
      result.dryRun ? 'Dry run: nothing was written. These files would change:' : 'i18n-companion is set up. Changed:',
      describeChanges(changes),
      result.keptExistingConfig ? `  kept   ${result.keptExistingConfig}  (existing config is never overwritten)` : '',
      result.registry ? `\nTracking ${result.registry.messages} messages; ${result.registry.adoptedExisting} existing translations were adopted as reviewed.` : '',
      result.dryRun ? '' : '\nNext: ask your assistant to "localize this app", or run `npx i18n-companion audit`.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return 0;
}

/** The bounded next-intl setup recipe. It prints; it never edits next.config or layouts. */
export async function cmdSetup(ctx: Context): Promise<number> {
  const detection = await detectProject(ctx.root);
  if (detection.support === 'none' || (detection.support === 'audit-only' && detection.i18n.library !== 'none')) return refuseUnsupported(ctx, detection);
  const base = detection.framework.appDir?.startsWith('src/') ? 'src/' : '';
  const messagesDir = detection.messagesDir ?? 'messages';
  const source = ctx.flags.source ?? 'en';
  const toMessages = path.posix.relative(`${base}i18n`, messagesDir);
  const requestTs = `import {getRequestConfig} from 'next-intl/server';

type Messages = {[key: string]: string | Messages};

const SOURCE_LOCALE = '${source}';

/** Fills gaps in a translation with the source text, so a missing message never shows its key. */
function withFallback(source: Messages, target: Messages): Messages {
  const out: Messages = {...source};
  for (const [key, value] of Object.entries(target)) {
    const base = out[key];
    out[key] = typeof value === 'object' && typeof base === 'object' ? withFallback(base, value) : value;
  }
  return out;
}

export default getRequestConfig(async () => {
  // Without locale routing, pick the locale here (a cookie or the Accept-Language header).
  const locale = SOURCE_LOCALE;
  const source = (await import(\`${toMessages}/\${SOURCE_LOCALE}.json\`)).default as Messages;
  const messages = locale === SOURCE_LOCALE ? source : withFallback(source, (await import(\`${toMessages}/\${locale}.json\`)).default as Messages);
  return {locale, messages};
});
`;
  const nextConfig = `import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin();

/** @type {import('next').NextConfig} */
const nextConfig = {
  // your existing options
};

export default withNextIntl(nextConfig);`;
  const layout = `import {NextIntlClientProvider} from 'next-intl';

// In ${base}app/layout.tsx, wrap the body's children:
<body>
  <NextIntlClientProvider>{children}</NextIntlClientProvider>
</body>`;
  const steps = [
    {step: 'Install next-intl', command: `${detection.packageManager} ${detection.packageManager === 'npm' ? 'install' : 'add'} next-intl`},
    {step: `Create ${messagesDir}/${source}.json`, file: `${messagesDir}/${source}.json`, content: '{}\n'},
    {step: `Create ${base}i18n/request.ts`, file: `${base}i18n/request.ts`, content: requestTs},
    {step: 'Wrap your Next config (edit it by hand; this tool never changes next.config)', file: 'next.config.ts', content: nextConfig},
    {step: 'Provide messages to client components', file: `${base}app/layout.tsx`, content: layout},
    {step: 'Then run init', command: 'npx i18n-companion init'},
  ];
  emit(ctx, {ok: true, library: 'next-intl', steps}, () =>
    [
      'next-intl setup recipe. Nothing was changed; apply these steps yourself (or ask your assistant to).',
      'The request config merges the source catalog under every translation, because next-intl otherwise shows the message key when a translation is missing.',
      '',
      ...steps.map((s, i) => [`${i + 1}. ${s.step}`, s.command ? `   ${s.command}` : '', s.content ? s.content.replace(/^/gm, '   ') : ''].filter(Boolean).join('\n')),
    ].join('\n'),
  );
  return 0;
}

export async function cmdUninstall(ctx: Context): Promise<number> {
  const changes = await planUninstall(ctx.root);
  const apply = Boolean(ctx.flags.yes);
  if (apply && changes.length) await applyChanges(ctx.root, changes);
  emit(ctx, {ok: true, applied: apply && changes.length > 0, changes: changes.map(({path: p, action, description}) => ({path: p, action, description}))}, () => {
    if (!changes.length) return 'Nothing to uninstall: no install record was found.';
    return [
      apply ? 'Removed:' : 'Preview. Run again with --yes to remove:',
      describeChanges(changes),
      'Your config, catalogs, registry and code are never touched by uninstall.',
    ].join('\n');
  });
  return 0;
}
