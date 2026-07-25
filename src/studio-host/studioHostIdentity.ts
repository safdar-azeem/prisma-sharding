import crypto from 'crypto';
import path from 'path';
import { normalizeDatabaseUrl } from '../cli/utils/shards';
import { StudioHostTarget } from './studioHostTargets';

/**
 * Identity of a running Studio host.
 *
 * Per-shard Studio fingerprinted one project + one database. A single host
 * serves every configured shard, so reuse is only safe when the ENTIRE
 * configured set matches: same project root, same schema, same shard IDs in
 * the same order, pointing at the same physical databases.
 *
 * A project that gains, loses or repoints a shard therefore gets a different
 * fingerprint and will never silently attach to a host serving a stale set.
 */
export interface StudioHostIdentity {
  projectRoot: string;
  schemaPath: string;
  targets: readonly Pick<StudioHostTarget, 'id' | 'url'>[];
}

/**
 * Bumped whenever the host's wire contract changes, so an older host left
 * running by a previous install is never reused by a newer CLI.
 */
export const STUDIO_HOST_PROTOCOL_VERSION = 1;

/**
 * SHA-256 over credential-free material only.
 *
 * `normalizeDatabaseUrl` strips userinfo, so passwords never participate in
 * the hash and the fingerprint is safe to write to the registry on disk and to
 * expose on the host's identity endpoint.
 */
export const computeStudioHostFingerprint = (identity: StudioHostIdentity): string => {
  const material = [
    `v${STUDIO_HOST_PROTOCOL_VERSION}`,
    path.resolve(identity.projectRoot),
    identity.schemaPath || '',
    ...identity.targets.map((target) => `${target.id}\t${normalizeDatabaseUrl(target.url)}`),
  ].join('\n');

  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
};
