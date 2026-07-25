import * as studioUi from '@prisma/studio-core/ui';

/**
 * What the installed `@prisma/studio-core` build actually supports.
 *
 * The host renders its shard selector into Studio's generic `headerEndContent`
 * slot and relies on `onPendingChangesChange` to know when switching would
 * discard staged edits. Both are additive Studio APIs: a build that predates
 * them ignores the props silently, which would leave the shard selector
 * invisible and the unsaved-work guard permanently quiet.
 *
 * Rather than fail in a way that looks like a bug, the shell probes for the
 * `NO_STUDIO_PENDING_CHANGES` export that ships alongside those APIs, and falls
 * back to a host-owned bar above Studio when it is missing.
 */
export interface StudioShellCapabilities {
  /** Studio renders host-provided controls inside its header. */
  hasHeaderSlot: boolean;
  /** Studio reports unsaved staged edits to the host. */
  hasPendingChangesReporting: boolean;
}

export const detectStudioShellCapabilities = (
  studioModule: Record<string, unknown> = studioUi as unknown as Record<string, unknown>
): StudioShellCapabilities => {
  const supportsHostExtensions = 'NO_STUDIO_PENDING_CHANGES' in studioModule;

  return {
    hasHeaderSlot: supportsHostExtensions,
    hasPendingChangesReporting: supportsHostExtensions,
  };
};

export const STUDIO_SHELL_LEGACY_CORE_NOTICE =
  'This @prisma/studio-core build predates the Studio host extension points, so the ' +
  'database selector is shown above Studio and unsaved edits are not detected before ' +
  'switching. Upgrade @prisma/studio-core to restore both.';
