import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {applyPlan, checkPlan, createPlan, importResponse, nextBatch, readPlan, MAX_ATTEMPTS, type PlanFile} from '../src/core/plan.js';
import {loadProject, readState, saveRegistry, type Project} from '../src/core/project.js';
import {messageStatus, reviewTranslations} from '../src/core/review.js';
import {checkProject} from '../src/core/check.js';
import {CompanionError} from '../src/core/diagnostics.js';
import {fakeTranslate, readJson, snapshot, useFixture} from './helpers.js';

/** init's job, minus the assistant files: record the starting state in the registry. */
async function start(): Promise<{root: string; project: Project}> {
  const root = await useFixture('next-intl-existing');
  const project = await loadProject(root);
  const state = await readState(project);
  await saveRegistry(project, state.registry);
  return {root, project};
}

/** Plan, translate every batch with the fake translator, apply. */
async function localize(project: Project, options: Parameters<typeof createPlan>[1] = {}): Promise<PlanFile> {
  let plan = await createPlan(project, options);
  for (;;) {
    const batch = await nextBatch(project, plan, 50);
    if (!batch.batchId) break;
    plan = await readPlan(project, plan.id);
    await importResponse(project, plan, fakeTranslate(batch));
    plan = await readPlan(project, plan.id);
  }
  await applyPlan(project, plan);
  return readPlan(project, plan.id);
}

async function setSource(root: string, id: string, text: string): Promise<void> {
  const file = path.join(root, 'messages/en.json');
  const tree = await readJson<Record<string, Record<string, string>>>(file);
  const [ns, key] = id.split('.') as [string, string];
  tree[ns]![key] = text;
  await writeFile(file, JSON.stringify(tree, null, 2) + '\n');
}

describe('first sync', () => {
  it('adopts translations that already exist as human-reviewed', async () => {
    const {project} = await start();
    const rows = await messageStatus(project);
    const status = (id: string, locale: string) => rows.find((r) => r.id === id && r.locale === locale)?.status;
    expect(status('Common.cancel', 'fr')).toBe('human-reviewed');
    expect(status('Common.cancel', 'de')).toBe('human-reviewed');
    expect(status('Home.title', 'de')).toBe('missing');
  });
});

describe('plan and apply', () => {
  it('finds hardcoded text in a server page and a client component', async () => {
    const {project} = await start();
    const plan = await createPlan(project);
    expect(plan.files.map((f) => f.file).sort()).toEqual(['src/app/checkout/page.tsx', 'src/components/order-summary.tsx']);
    const ids = plan.newMessages.map((m) => m.id);
    expect(ids).toContain('Checkout.checkout');
    // The client component already has a Common translator, so its new keys go there.
    expect(ids.some((id) => id.startsWith('Common.orderTotal'))).toBe(true);
    expect(plan.newMessages.find((m) => m.id.startsWith('Common.orderTotal'))?.source).toBe('Order total: {total}');
  });

  it('rewrites code, writes catalogs and records machine-validated translations', async () => {
    const {root, project} = await start();
    await localize(project);
    const page = await readFile(path.join(root, 'src/app/checkout/page.tsx'), 'utf8');
    expect(page).toContain("import {getTranslations} from 'next-intl/server';");
    expect(page).toContain("await getTranslations('Checkout')");
    expect(page).not.toContain('<h1>Checkout</h1>');
    const client = await readFile(path.join(root, 'src/components/order-summary.tsx'), 'utf8');
    expect(client).toMatch(/\{t\('orderTotal\w*', \{total\}\)\}/);

    const en = await readJson<Record<string, Record<string, string>>>(path.join(root, 'messages/en.json'));
    expect(en.Checkout?.checkout).toBe('Checkout');
    const fr = await readJson<Record<string, Record<string, string>>>(path.join(root, 'messages/fr.json'));
    expect(fr.Checkout?.checkout).toBe('[fr] Checkout');
    // A reviewed translation is never overwritten.
    expect(fr.Common?.cancel).toBe('Annuler');

    const rows = await messageStatus(project);
    expect(rows.find((r) => r.id === 'Checkout.checkout' && r.locale === 'de')?.status).toBe('machine-validated');
    expect(rows.find((r) => r.id === 'Home.title' && r.locale === 'de')?.status).toBe('machine-validated');
    expect((await checkProject(project)).ok).toBe(true);
  });

  it('makes no change on a second run', async () => {
    const {root, project} = await start();
    await localize(project);
    const before = await snapshot(root);
    const second = await createPlan(project);
    expect(second.files).toEqual([]);
    expect(second.newMessages).toEqual([]);
    expect(second.work).toEqual([]);
    await applyPlan(project, second);
    expect(await snapshot(root)).toEqual(before);
  });

  it('keeps message identity when a file moves', async () => {
    const {root, project} = await start();
    await localize(project);
    await mkdir(path.join(root, 'src/components/cart'));
    await rename(path.join(root, 'src/components/order-summary.tsx'), path.join(root, 'src/components/cart/order-summary.tsx'));
    const plan = await createPlan(project);
    expect(plan.newMessages).toEqual([]);
    expect(plan.work).toEqual([]);
    const id = Object.keys(plan.occurrences).find((k) => k.startsWith('Common.orderTotal'))!;
    expect(plan.occurrences[id]?.[0]?.file).toBe('src/components/cart/order-summary.tsx');
  });
});

describe('changes after translation', () => {
  it('stales only the translations of the message that changed', async () => {
    const {root, project} = await start();
    await localize(project);
    await setSource(root, 'Checkout.checkout', 'Secure checkout');
    const rows = await messageStatus(project);
    const stale = rows.filter((r) => r.status === 'stale').map((r) => `${r.id}/${r.locale}`).sort();
    expect(stale).toEqual(['Checkout.checkout/de', 'Checkout.checkout/fr']);
  });

  it('keeps a human translation and records the new suggestion as a proposal', async () => {
    const {root, project} = await start();
    await setSource(root, 'Common.cancel', 'Cancel order');
    await localize(project, {code: false});
    const fr = await readJson<Record<string, Record<string, string>>>(path.join(root, 'messages/fr.json'));
    expect(fr.Common?.cancel).toBe('Annuler');
    const row = (await messageStatus(project, 'Common.cancel', ['fr']))[0]!;
    expect(row.proposal).toBe('[fr] Cancel order');

    await reviewTranslations(project, 'Common.cancel', {locales: ['fr'], acceptProposal: true});
    const after = await readJson<Record<string, Record<string, string>>>(path.join(root, 'messages/fr.json'));
    expect(after.Common?.cancel).toBe('[fr] Cancel order');
    expect((await messageStatus(project, 'Common.cancel', ['fr']))[0]?.status).toBe('human-reviewed');
  });

  it('treats an edit made outside the tool as human-reviewed', async () => {
    const {root, project} = await start();
    await localize(project);
    const file = path.join(root, 'messages/de.json');
    const de = await readJson<Record<string, Record<string, string>>>(file);
    de.Checkout!.checkout = 'Kasse';
    await writeFile(file, JSON.stringify(de, null, 2) + '\n');
    expect((await messageStatus(project, 'Checkout.checkout', ['de']))[0]?.status).toBe('human-reviewed');
  });

  it('rejects a translation made for an older source revision', async () => {
    const {root, project} = await start();
    let plan = await createPlan(project, {code: false, locales: ['de']});
    const batch = await nextBatch(project, plan, 50);
    expect(batch.items.map((i) => i.id)).toContain('Home.title');
    await setSource(root, 'Home.title', 'Good to see you, {name}');
    plan = await readPlan(project, plan.id);
    const result = await importResponse(project, plan, fakeTranslate(batch));
    const rejected = result.rejected.find((r) => r.id === 'Home.title');
    expect(rejected?.diagnostics[0]?.code).toBe('I18N_STALE_REVISION');
  });

  it('gives up after repeated invalid answers and keeps the fallback', async () => {
    const {project} = await start();
    let plan = await createPlan(project, {code: false, locales: ['de']});
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const batch = await nextBatch(project, plan, 50);
      plan = await readPlan(project, plan.id);
      const bad = fakeTranslate(batch);
      for (const t of bad.translations) t.text = t.text.replace('{name}', '{nom}');
      await importResponse(project, plan, bad);
      plan = await readPlan(project, plan.id);
    }
    expect(plan.gaveUp.map((g) => g.id)).toContain('Home.title');
    const again = await nextBatch(project, plan, 50);
    expect(again.items.map((i) => i.id)).not.toContain('Home.title');
  });

  it('refuses ids and locales that were not asked for', async () => {
    const {project} = await start();
    let plan = await createPlan(project, {code: false, locales: ['de']});
    const batch = await nextBatch(project, plan, 50);
    plan = await readPlan(project, plan.id);
    const item = batch.items[0]!;
    const result = await importResponse(project, plan, {
      batchId: batch.batchId,
      translations: [
        {id: 'Not.asked', locale: 'de', sourceRevision: item.sourceRevision, text: 'x'},
        {id: item.id, locale: 'fr', sourceRevision: item.sourceRevision, text: 'x'},
      ],
    });
    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((r) => r.diagnostics[0]?.code)).toEqual(['I18N_UNEXPECTED_ID', 'I18N_WRONG_LOCALE']);
  });

  it('reports a conflict when a planned file changed, and applies nothing', async () => {
    const {root, project} = await start();
    const plan = await createPlan(project);
    const file = path.join(root, 'src/app/checkout/page.tsx');
    await writeFile(file, (await readFile(file, 'utf8')).replace('Checkout', 'Pay'));
    const before = await snapshot(root);
    const check = await checkPlan(project, plan);
    expect(check.ok).toBe(false);
    expect(check.conflicts[0]?.code).toBe('I18N_PLAN_CONFLICT');
    await expect(applyPlan(project, plan)).rejects.toBeInstanceOf(CompanionError);
    expect(await snapshot(root)).toEqual(before);
  });
});

describe('check', () => {
  it('fails on hardcoded text and missing translations before localizing', async () => {
    const {project} = await start();
    const result = await checkProject(project);
    expect(result.ok).toBe(false);
    expect(result.failedOn.sort()).toEqual(['hardcoded', 'missing']);
    expect(result.locales.find((l) => l.locale === 'fr')?.coverage).toBe(100);
  });

  it('limits the hardcoded-text scan to the files given', async () => {
    const {project} = await start();
    const result = await checkProject(project, {files: ['src/app/page.tsx']});
    expect(result.failedOn).not.toContain('hardcoded');
    expect(result.filesChecked).toBe(1);
  });
});
