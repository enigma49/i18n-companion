import type {BatchPayload, BatchResponse} from '../core/plan.js';

/** Something that can translate a batch of catalog messages without a person in the loop. */
export interface TranslationProvider {
  readonly name: string;
  readonly model?: string;
  translateBatch(batch: BatchPayload): Promise<BatchResponse>;
}

/** Something that can translate one piece of dynamic content (used by the runtime module). */
export interface ContentProvider {
  readonly name: string;
  readonly model?: string;
  translateText(input: {text: string; sourceLocale: string; targetLocale: string; context?: string; signal?: AbortSignal}): Promise<string>;
}
