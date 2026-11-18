import {spawnSync} from 'node:child_process';
import {watch} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {analyzeFile} from '../adapters/next-intl/index.js';
import {runbook} from '../assistant/templates.js';
import {checkProject} from '../core/check.js';
import {findConfigFile} from '../core/config.js';
import {defaultIncludes, detectProject, readPackageJson} from '../core/detect.js';
import {CompanionError, diag, type Diagnostic} from '../core/diagnostics.js';
import {listFiles, matchesAny, toPosix} from '../core/fsutil.js';
import {inspectProject} from '../core/inspect.js';
import {applyPlan, checkPlan, createPlan, importResponse, nextBatch, readPlan, type PlanFile} from '../core/plan.js';
import {loadProject, readState, saveRegistry, type Project} from '../core/project.js';
import {messageStatus, reviewTranslations} from '../core/review.js';
import {summarizePlan, type PlanSummary} from '../core/summary.js';
import {providerFromConfig, translatePlanWithProvider} from '../providers/run.js';
import {emit, formatDiagnostics, intFlag, list, readStdin, usageError, type Context} from './io.js';

function planText(s: PlanSummary): string {
  const work = Object.entries(s.work)
    .map(([l, w]) => `  ${l}: ${w.new} new, ${w.missing} missing, ${w.stale} stale`)
    .join('\n');
  return [
    `Plan ${s.planId}${s.applied ? ' (applied)' : ''}`,
    `Code files to change: ${s.filesToChange.length}${s.filesToChange.length ? `\n  ${s.filesToChange.join('\n  ')}` : ''}`,
    `New source messages: ${s.messagesToAdd}`,
    `Translation work:\n${work}`,
    s.needsDecision.length ? `Needs a person's decision:\n${formatDiagnostics(s.needsDecision)}` : '',
    s.diagnostics.length ? `Other notes:\n${formatDiagnostics(s.diagnostics, 20)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export async function cmdDoctor(ctx: Context): Promise<number> {
  const report = await inspectProject(ctx.root);
  emit(ctx, report, () =>
    [
      `i18n-companion ${report.tool} on Node ${report.node}`,
      `Framework: ${report.detection.framework.name}${report.detection.framework.version ? ` ${report.detection.framework.version}` : ''} (${report.detection.framework.router ?? 'no router found'})`,
      `i18n library: ${report.detection.i18n.library}${report.detection.i18n.version ? ` ${report.detection.i18n.version}` : ''}`,
      `Support: ${report.detection.support}`,
      `Config: ${report.config.file ? `${path.basename(report.config.file)} (${report.config.valid ? 'valid' : 'invalid'})` : 'none'}`,
      ...report.locales.map((l) => `  ${l.locale}: ${l.total - l.counts.missing}/${l.total} translated, ${l.counts.stale} stale, ${l.counts['human-reviewed']} reviewed`),
      formatDiagnostics(report.diagnostics),
      report.ok ? 'Ready.' : 'Not ready; see the notes above.',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return report.ok ? 0 : 1;
}

/** Read-only scan. Works with no config at all, and on projects the tool cannot change. */
export async function cmdAudit(ctx: Context): Promise<number> {
  const detection = await detectProject(ctx.root);
  let include = defaultIncludes(detection.framework.appDir);
  let exclude: string[] = [];
  if (findConfigFile(ctx.root)) {
    const project = await loadProject(ctx.root);
    include = project.config.include;
    exclude = project.config.exclude;
  }
  const files = await listFiles(ctx.root, include, exclude);
  const perFile: {file: string; hardcoded: number; translated: number}[] = [];
  const diagnostics: Diagnostic[] = [...detection.diagnostics];
  for (const file of files) {
    const {analysis} = await analyzeFile(ctx.root, file);
    const hardcoded = analysis.diagnostics.filter((d) => d.code === 'I18N_HARDCODED_STRING').length;
    diagnostics.push(...analysis.diagnostics);
    if (hardcoded || analysis.usages.length) perFile.push({file, hardcoded, translated: analysis.usages.length});
  }
  const hardcoded = perFile.reduce((n, f) => n + f.hardcoded, 0);
  const result = {ok: true, support: detection.support, library: detection.i18n.library, filesScanned: files.length, hardcoded, files: perFile, diagnostics};
  emit(ctx, result, () =>
    [
      `Audit (read-only). Support: ${detection.support}, library: ${detection.i18n.library}.`,
      `Scanned ${files.length} files; ${hardcoded} hardcoded strings in ${perFile.filter((f) => f.hardcoded).length} files.`,
      ...perFile.filter((f) => f.hardcoded).sort((a, b) => b.hardcoded - a.hardcoded).slice(0, 20).map((f) => `  ${String(f.hardcoded).padStart(4)}  ${f.file}`),
      formatDiagnostics(diagnostics.filter((d) => d.code !== 'I18N_HARDCODED_STRING'), 20),
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return 0;
}

export async function cmdPlan(ctx: Context): Promise<number> {
  const project = await loadProject(ctx.root);
  const plan = await createPlan(project, {paths: list(ctx.flags.paths), code: ctx.flags.code ?? true, locales: list(ctx.flags.locales)});
  const summary = summarizePlan(plan);
  emit(ctx, summary, () => planText(summary));
  return 0;
}

export async function cmdBatch(ctx: Context): Promise<number> {
  const project = await loadProject(ctx.root);
  const batch = await nextBatch(project, await readPlan(project, ctx.flags.plan ?? 'latest'), intFlag(ctx.flags.size, 'size', 25));
  // The batch is a payload for a translator, so it is JSON either way.
  ctx.out(JSON.stringify(batch, null, 2));
  return 0;
}

export async function cmdImport(ctx: Context): Promise<number> {
  const input = ctx.flags.input;
  if (!input) throw usageError('import needs --input <file>, or --input - to read standard input.');
  const text = input === '-' ? await readStdin() : await readFile(path.resolve(ctx.root, input), 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new CompanionError(diag('I18N_RESPONSE_INVALID', 'error', `The response is not valid JSON: ${(error as Error).message}`), 1);
  }
  const project = await loadProject(ctx.root);
  const result = await importResponse(project, await readPlan(project, ctx.flags.plan ?? 'latest'), raw, 'assistant');
  emit(ctx, result, () =>
    [
      `Accepted ${result.accepted.length}, rejected ${result.rejected.length}, gave up on ${result.gaveUp.length}. ${result.remaining} item(s) left.`,
      formatDiagnostics(result.rejected.flatMap((r) => r.diagnostics)),
      result.rejected.length ? 'Rejected items come back in the next batch with their errors.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return result.rejected.length ? 1 : 0;
}

export async function cmdCheck(ctx: Context): Promise<number> {
  const project = await loadProject(ctx.root);
  if (ctx.flags.plan) {
    const check = await checkPlan(project, await readPlan(project, ctx.flags.plan));
    emit(ctx, check, () =>
      [
        check.ok ? 'The plan can be applied.' : 'The plan cannot be applied as it is.',
        `  files: ${check.summary.filesToChange.length}, new messages: ${check.summary.messagesToAdd}, translations: ${check.summary.translationsToWrite}, proposals: ${check.summary.proposals}, not done: ${check.summary.pending}, gave up: ${check.summary.gaveUp}`,
        formatDiagnostics([...check.conflicts, ...check.diagnostics]),
      ]
        .filter(Boolean)
        .join('\n'),
    );
    return check.ok ? 0 : 1;
  }
  const result = await checkProject(project, {files: list(ctx.flags.files), changedSince: ctx.flags.changed ? (ctx.flags.base ?? 'main') : undefined});
  emit(ctx, result, () =>
    [
      ...result.locales.map((l) => `  ${l.locale}: ${l.coverage}% translated, ${l.reviewed}% reviewed, ${l.counts.stale} stale, ${l.counts.draft} draft`),
      `Scanned ${result.filesChecked} source files.`,
      formatDiagnostics(result.diagnostics.filter((d) => d.severity !== 'info')),
      result.ok ? 'Check passed.' : `Check failed on: ${result.failedOn.join(', ')}.`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return result.ok ? 0 : 1;
}

export async function cmdApply(ctx: Context): Promise<number> {
  const project = await loadProject(ctx.root);
  const result = await applyPlan(project, await readPlan(project, ctx.flags.plan ?? 'latest'));
  emit(ctx, result, () =>
    [
      `Applied. Wrote ${result.written.length} file(s):`,
      ...result.written.map((f) => `  ${f}`),
      result.check.summary.pending ? `${result.check.summary.pending} translation(s) are not done; those messages show the source text until they are.` : '',
      formatDiagnostics(result.check.diagnostics.filter((d) => d.severity !== 'info')),
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return 0;
}

export async function cmdStatus(ctx: Context): Promise<number> {
  const project = await loadProject(ctx.root);
  const rows = await messageStatus(project, ctx.positionals[0] ?? '*', list(ctx.flags.locales));
  emit(ctx, rows, () => {
    if (!rows.length) return 'No matching messages.';
    const shown = rows.slice(0, 200).map((r) => `  ${r.status.padEnd(17)} ${r.locale.padEnd(6)} ${r.id}${r.proposal ? '  (proposal waiting)' : ''}`);
    if (rows.length > 200) shown.push(`  … and ${rows.length - 200} more (use --json for all)`);
    return shown.join('\n');
  });
  return 0;
}

export async function cmdReview(ctx: Context): Promise<number> {
  const selector = ctx.positionals[0];
  if (!selector) throw usageError('review needs a message id or namespace, for example `review Checkout` or `review Checkout.payNow`.');
  if (ctx.flags['accept-proposal'] && ctx.flags['reject-proposal']) throw usageError('Use --accept-proposal or --reject-proposal, not both.');
  const project = await loadProject(ctx.root);
  const rows = await reviewTranslations(project, selector, {
    locales: list(ctx.flags.locales),
    acceptProposal: ctx.flags['accept-proposal'],
    rejectProposal: ctx.flags['reject-proposal'],
  });
  emit(ctx, rows, () => [`Updated ${rows.length} translation(s):`, ...rows.map((r) => `  ${r.status.padEnd(17)} ${r.locale.padEnd(6)} ${r.id}`)].join('\n'));
  return 0;
}

export async function cmdSync(ctx: Context): Promise<number> {
  const project = await loadProject(ctx.root);
  const state = await readState(project);
  await saveRegistry(project, state.registry);
  const c = state.changes;
  emit(ctx, c, () =>
    `Registry synced: ${c.added.length} added, ${c.changed.length} changed, ${c.removed.length} removed, ${c.humanEdits.length} edits by a person, ${c.adoptedExisting.length} existing translations adopted.`,
  );
  return 0;
}

async function translateAndApply(ctx: Context, project: Project, plan: PlanFile, apply: boolean): Promise<{code: number; data: Record<string, unknown>}> {
  const provider = providerFromConfig(project);
  const run = await translatePlanWithProvider(project, plan.id, provider, {
    onBatch: (r, locale) => {
      if (!ctx.json) ctx.err(`  ${locale}: ${r.accepted.length} accepted, ${r.rejected.length} rejected, ${r.remaining} left`);
    },
  });
  const data: Record<string, unknown> = {planId: plan.id, model: provider.model, batches: run.batches, accepted: run.accepted, rejected: run.rejected, gaveUp: run.gaveUp};
  if (!apply) return {code: 0, data: {...data, applied: false}};
  const check = await checkPlan(project, await readPlan(project, plan.id));
  if (check.conflicts.length) return {code: 1, data: {...data, applied: false, conflicts: check.conflicts}};
  const result = await applyPlan(project, await readPlan(project, plan.id));
  return {code: run.gaveUp ? 1 : 0, data: {...data, applied: true, written: result.written}};
}

/** Provider mode: plan (translations only, unless --code), translate every batch, then apply. */
export async function cmdTranslate(ctx: Context): Promise<number> {
  const project = await loadProject(ctx.root);
  const plan = ctx.flags.plan
    ? await readPlan(project, ctx.flags.plan)
    : await createPlan(project, {paths: list(ctx.flags.paths), code: ctx.flags.code ?? false, locales: list(ctx.flags.locales)});
  const {code, data} = await translateAndApply(ctx, project, plan, ctx.flags.apply ?? true);
  emit(ctx, data, () =>
    `Translated with ${String(data.model)}: ${String(data.accepted)} accepted, ${String(data.rejected)} rejected, ${String(data.gaveUp)} gave up. ${data.applied ? 'Applied.' : 'Staged in the plan; run apply to write it.'}`,
  );
  return code;
}

/** Runs the package.json scripts named in the config. Only script names, never commands. */
export async function cmdRunChecks(ctx: Context): Promise<number> {
  const project = await loadProject(ctx.root);
  const pkg = await readPackageJson(ctx.root);
  const {packageManager} = await detectProject(ctx.root);
  const bin = process.platform === 'win32' ? `${packageManager}.cmd` : packageManager;
  const results: {script: string; exitCode: number | null; skipped?: string}[] = [];
  for (const script of project.config.checks) {
    if (!pkg?.scripts?.[script]) {
      results.push({script, exitCode: null, skipped: 'no such script in package.json'});
      continue;
    }
    if (!ctx.json) ctx.err(`> ${packageManager} run ${script}`);
    const r = spawnSync(bin, ['run', script], {cwd: ctx.root, stdio: ctx.json ? 'pipe' : 'inherit', shell: false});
    results.push({script, exitCode: r.status});
  }
  const failed = results.filter((r) => r.exitCode !== 0);
  emit(ctx, {ok: failed.length === 0, results}, () =>
    results.length
      ? results.map((r) => `  ${r.exitCode === 0 ? 'pass' : r.skipped ? 'skip' : 'FAIL'}  ${r.script}${r.skipped ? ` (${r.skipped})` : ''}`).join('\n')
      : 'No checks are configured. Add package.json script names to `checks` in the config.',
  );
  return failed.length ? 1 : 0;
}

const WATCH_IGNORE = ['.i18n-companion/', 'node_modules/', '.next/', '.git/', 'dist/'];

/**
 * Watches source and catalog files. In provider mode it translates catalog changes (never code)
 * and applies them; in assistant mode it syncs the registry and says what needs translating.
 */
export async function cmdWatch(ctx: Context): Promise<number> {
  const project = await loadProject(ctx.root);
  const delay = intFlag(ctx.flags.debounce, 'debounce', 800);
  const provider = project.config.translation.mode === 'provider';
  const messagesPrefix = `${toPosix(project.config.messagesDir).replace(/\/$/, '')}/`;
  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let again = false;

  const cycle = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const fresh = await loadProject(ctx.root);
      if (provider) {
        const plan = await createPlan(fresh, {code: false});
        if (plan.work.length) {
          const {data} = await translateAndApply(ctx, fresh, plan, true);
          ctx.err(`[watch] translated ${String(data.accepted)} message(s)${data.gaveUp ? `, gave up on ${String(data.gaveUp)}` : ''}`);
        }
      } else {
        const state = await readState(fresh);
        await saveRegistry(fresh, state.registry);
        const rows = await messageStatus(fresh);
        const open = rows.filter((r) => r.status === 'missing' || r.status === 'stale').length;
        ctx.err(open ? `[watch] ${open} translation(s) missing or stale. Ask your assistant to translate them.` : '[watch] all translations are current.');
      }
    } catch (error) {
      ctx.err(`[watch] ${error instanceof CompanionError ? error.diagnostic.message : String(error)}`);
    } finally {
      running = false;
      if (again) {
        again = false;
        void cycle();
      }
    }
  };

  const watcher = watch(ctx.root, {recursive: true}, (_event, filename) => {
    if (!filename) return;
    const rel = toPosix(filename.toString());
    if (WATCH_IGNORE.some((p) => rel.startsWith(p) || rel.includes(`/${p}`))) return;
    if (!rel.startsWith(messagesPrefix) && !matchesAny(rel, project.config.include)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void cycle(), delay);
  });
  ctx.err(`Watching for changes (${provider ? 'provider mode: translations are applied automatically' : 'assistant mode'}). Ctrl+C to stop.`);
  await cycle();
  return new Promise((resolve) => {
    process.once('SIGINT', () => {
      watcher.close();
      clearTimeout(timer);
      resolve(0);
    });
  });
}

export async function cmdRunbook(ctx: Context): Promise<number> {
  emit(ctx, {runbook: runbook()}, () => runbook());
  return 0;
}
