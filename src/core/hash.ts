import {createHash} from 'node:crypto';

export function sha256(value: string): string {
  return 'sha256:' + createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Short form for display only; never use it as an identity. */
export function shortRev(rev: string): string {
  return rev.replace(/^sha256:/, '').slice(0, 8);
}

/**
 * The source revision of a message: everything a translator relied on. If any of it changes,
 * every translation made against the old revision becomes stale.
 */
export function sourceRevision(source: string, description?: string): string {
  return sha256(JSON.stringify({source, description: description ?? null}));
}

export function textRevision(text: string): string {
  return sha256(text);
}
