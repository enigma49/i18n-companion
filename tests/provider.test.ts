import {describe, expect, it} from 'vitest';
import {createPlan, readPlan} from '../src/core/plan.js';
import {loadProject, readState, saveRegistry} from '../src/core/project.js';
import {createAnthropicProvider, DEFAULT_ANTHROPIC_MODEL, type AnthropicLikeClient} from '../src/providers/anthropic.js';
import {translatePlanWithProvider} from '../src/providers/run.js';
import {CompanionError} from '../src/core/diagnostics.js';
import {useFixture} from './helpers.js';

type Params = Record<string, unknown> & {messages: {content: string}[]};

/** A stand-in for the Anthropic client: answers with a function of the request. */
function fakeClient(answer: (input: {targetLocale: string; items: {id: string; source: string}[]}) => unknown, stopReason = 'end_turn') {
  const calls: Params[] = [];
  const client: AnthropicLikeClient = {
    beta: {
      messages: {
        async parse(params) {
          calls.push(params as Params);
          const input = JSON.parse((params as Params).messages[0]!.content);
          return {stop_reason: stopReason, parsed_output: answer(input)};
        },
      },
    },
  };
  return {client, calls};
}

async function project() {
  const root = await useFixture('next-intl-existing');
  const p = await loadProject(root);
  await saveRegistry(p, (await readState(p)).registry);
  return p;
}

describe('Anthropic provider', () => {
  it('translates a plan end to end with the configured defaults', async () => {
    const p = await project();
    const plan = await createPlan(p);
    const {client, calls} = fakeClient((input) => ({translations: input.items.map((i) => ({id: i.id, text: `[${input.targetLocale}] ${i.source}`}))}));
    const provider = createAnthropicProvider({client});
    const result = await translatePlanWithProvider(p, plan.id, provider);
    expect(result.rejected).toBe(0);
    expect(result.accepted).toBe(plan.work.length);
    expect(calls[0]?.model).toBe(DEFAULT_ANTHROPIC_MODEL);
    expect(calls[0]?.fallbacks).toBe('default');
    const after = await readPlan(p, plan.id);
    expect(after.staged.every((s) => s.by === 'provider' && s.model === DEFAULT_ANTHROPIC_MODEL)).toBe(true);
  });

  it('ignores ids the model invents and retries skipped items until the limit', async () => {
    const p = await project();
    const plan = await createPlan(p, {code: false, locales: ['de']});
    // Answers only an invented id, so every real item is skipped each time.
    const {client, calls} = fakeClient(() => ({translations: [{id: 'Made.up', text: 'x'}]}));
    const result = await translatePlanWithProvider(p, plan.id, createAnthropicProvider({client}));
    expect(result.accepted).toBe(0);
    expect(result.gaveUp).toBe(plan.work.length);
    expect(calls.length).toBe(2);
  });

  it('turns a refusal into a provider error', async () => {
    const {client} = fakeClient(() => null, 'refusal');
    const provider = createAnthropicProvider({client});
    await expect(provider.translateText({text: 'Hello', sourceLocale: 'en', targetLocale: 'fr'})).rejects.toBeInstanceOf(CompanionError);
  });

  it('uses the model from the config', async () => {
    const {client, calls} = fakeClient(() => ({text: 'Bonjour'}));
    const provider = createAnthropicProvider({client, model: 'claude-sonnet-5-5'});
    expect(await provider.translateText({text: 'Hello', sourceLocale: 'en', targetLocale: 'fr'})).toBe('Bonjour');
    expect(calls[0]?.model).toBe('claude-sonnet-5-5');
  });
});
