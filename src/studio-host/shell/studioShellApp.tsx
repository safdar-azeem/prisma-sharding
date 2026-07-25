import { Studio } from '@prisma-sharding/studio/ui';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StudioShardManifest } from '../studioHostManifest';
import { checkStudioShardStatus, fetchStudioShardManifest } from './studioShellApi';
import {
  detectStudioShellCapabilities,
  STUDIO_SHELL_LEGACY_CORE_NOTICE,
} from './studioShellCapabilities';
import {
  createStudioShellShardSession,
  StudioShellShardSession,
} from './studioShellShardSession';
import { StudioShellShardSelector } from './studioShellShardSelector';
import { StudioShellUnsavedChangesDialog } from './studioShellUnsavedChangesDialog';
import {
  readShardIdFromUrl,
  resolveInitialShardId,
  writeShardIdToUrl,
} from './studioShellUrlState';

interface PendingChanges {
  hasPendingChanges: boolean;
  stagedRowCount: number;
  stagedUpdateCount: number;
}

const NO_PENDING_CHANGES: PendingChanges = {
  hasPendingChanges: false,
  stagedRowCount: 0,
  stagedUpdateCount: 0,
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; manifest: StudioShardManifest };

const capabilities = detectStudioShellCapabilities();

/**
 * The single Studio shell.
 *
 * One browser application serves every configured shard. Exactly one shard is
 * active at a time and Studio is remounted, with a fresh adapter, whenever it
 * changes. The remount is deliberate: Studio builds its caches, collections and
 * query client per provider instance, so a new instance is the strongest
 * available guarantee that rows, introspection metadata, filters, selections,
 * pagination and operation state from one database can never be displayed as
 * another's - even when both databases have identical schemas.
 *
 * Presentation preferences (theme, navigation width, page size) live in
 * localStorage-backed collections and survive the remount, which is exactly the
 * intended split: global preferences persist, database-bound state does not.
 */
export function StudioShellApp() {
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [activeShardId, setActiveShardId] = useState<string | null>(null);
  const [pendingShardId, setPendingShardId] = useState<string | null>(null);
  const [confirmShardId, setConfirmShardId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingChanges, setPendingChanges] = useState<PendingChanges>(
    NO_PENDING_CHANGES
  );

  const sessionRef = useRef<StudioShellShardSession | null>(null);
  /**
   * Monotonic token. Every switch increments it, and any asynchronous step
   * that finishes against a superseded token is discarded, so rapid repeated
   * switching settles on the last requested shard instead of whichever request
   * happened to return last.
   */
  const switchTokenRef = useRef(0);
  const pendingChangesRef = useRef(pendingChanges);
  pendingChangesRef.current = pendingChanges;

  const manifest = loadState.kind === 'ready' ? loadState.manifest : null;
  const shards = useMemo(() => manifest?.shards ?? [], [manifest]);

  const applyShard = useCallback((shardId: string) => {
    const token = (switchTokenRef.current += 1);

    // End the previous session first: its in-flight requests are aborted and
    // any response still on the wire is refused before a new adapter exists.
    sessionRef.current?.dispose();
    sessionRef.current = createStudioShellShardSession(shardId);

    // Only the shard parameter changes. Studio's hash - view, schema, table,
    // filters, sorting - is preserved so the user stays where they were.
    writeShardIdToUrl(shardId);
    setActiveShardId(shardId);
    setPendingShardId(null);
    setPendingChanges(NO_PENDING_CHANGES);

    // Availability is probed for the selected shard only. Probing every shard
    // on load would open a connection per database just to draw a dot.
    void checkStudioShardStatus(shardId)
      .then((status) => {
        if (switchTokenRef.current !== token) {
          return;
        }

        setLoadState((current) =>
          current.kind === 'ready'
            ? {
                kind: 'ready',
                manifest: {
                  ...current.manifest,
                  shards: current.manifest.shards.map((shard) =>
                    shard.id === shardId
                      ? {
                          ...shard,
                          status: status.status,
                          statusMessage: status.message,
                        }
                      : shard
                  ),
                },
              }
            : current
        );
      })
      .catch(() => {
        // A failed probe only means the indicator stays unknown; Studio's own
        // introspection surfaces the real error with far better detail.
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    fetchStudioShardManifest(controller.signal)
      .then((loadedManifest) => {
        if (controller.signal.aborted) {
          return;
        }

        setLoadState({ kind: 'ready', manifest: loadedManifest });

        const { shardId, wasRequestedShardStale } = resolveInitialShardId({
          availableShardIds: loadedManifest.shards.map((shard) => shard.id),
          defaultShardId: loadedManifest.defaultShardId,
          requestedShardId: readShardIdFromUrl(),
        });

        if (wasRequestedShardStale) {
          setNotice(
            'The database in this link is no longer configured. Showing the default database instead.'
          );
        }

        if (shardId) {
          applyShard(shardId);
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }

        setLoadState({
          kind: 'failed',
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => controller.abort();
  }, [applyShard]);

  // No listener may outlive the page: the session owns its aborts and is
  // disposed when the shell unmounts.
  useEffect(() => () => sessionRef.current?.dispose(), []);

  const requestShard = useCallback(
    async (shardId: string) => {
      if (shardId === activeShardId || pendingShardId) {
        return;
      }

      setNotice(null);
      setPendingShardId(shardId);

      // Re-read configuration before committing. A shard removed from the
      // project's environment since the page loaded must not be switched to,
      // and this is cheap compared with the introspection that follows.
      let latestManifest: StudioShardManifest;

      try {
        latestManifest = await fetchStudioShardManifest();
      } catch {
        setPendingShardId(null);
        setNotice('Could not reach the Studio host. The current database is unchanged.');
        return;
      }

      setLoadState({ kind: 'ready', manifest: latestManifest });

      if (!latestManifest.shards.some((shard) => shard.id === shardId)) {
        setPendingShardId(null);
        setNotice('That database is no longer configured for this project.');
        return;
      }

      if (pendingChangesRef.current.hasPendingChanges) {
        // Staged inserts and edits belong to the current database. Leaving now
        // would either discard them or, worse, invite them to be written to a
        // different database later.
        setConfirmShardId(shardId);
        return;
      }

      applyShard(shardId);
    },
    [activeShardId, applyShard, pendingShardId]
  );

  const cancelSwitch = useCallback(() => {
    setConfirmShardId(null);
    setPendingShardId(null);
  }, []);

  const discardAndSwitch = useCallback(() => {
    const shardId = confirmShardId;
    setConfirmShardId(null);

    if (shardId) {
      applyShard(shardId);
    }
  }, [applyShard, confirmShardId]);

  const headerEndContent = useMemo(
    () => (
      <StudioShellShardSelector
        activeShardId={activeShardId}
        isSwitching={pendingShardId != null}
        onSelect={(shardId) => void requestShard(shardId)}
        pendingShardId={pendingShardId}
        shards={shards}
      />
    ),
    [activeShardId, pendingShardId, requestShard, shards]
  );

  if (loadState.kind === 'loading') {
    return (
      <ShellFrame>
        <ShellMessage title="Starting Prisma Sharding Studio" />
      </ShellFrame>
    );
  }

  if (loadState.kind === 'failed') {
    return (
      <ShellFrame>
        <ShellMessage
          detail={loadState.message}
          title="Could not load the database list"
        />
      </ShellFrame>
    );
  }

  if (shards.length === 0) {
    return (
      <ShellFrame>
        <ShellMessage
          detail={loadState.manifest.warnings.join(' ')}
          title="No databases are configured for this project"
        />
      </ShellFrame>
    );
  }

  const session = sessionRef.current;

  if (!session || !activeShardId) {
    return (
      <ShellFrame>
        <ShellMessage title="Selecting a database" />
      </ShellFrame>
    );
  }

  return (
    <ShellFrame>
      {notice ? (
        <div className="studio-shell__notice" role="status">
          {notice}
          <button
            aria-label="Dismiss notice"
            className="studio-shell__notice-dismiss"
            onClick={() => setNotice(null)}
            type="button"
          >
            ×
          </button>
        </div>
      ) : null}

      {capabilities.hasHeaderSlot ? null : (
        <div className="studio-shell__fallback-bar">
          {headerEndContent}
          <span className="studio-shell__fallback-note">
            {STUDIO_SHELL_LEGACY_CORE_NOTICE}
          </span>
        </div>
      )}

      <div className="studio-shell__studio">
        <Studio
          adapter={session.adapter}
          headerEndContent={capabilities.hasHeaderSlot ? headerEndContent : undefined}
          key={activeShardId}
          onPendingChangesChange={
            capabilities.hasPendingChangesReporting ? setPendingChanges : undefined
          }
        />
      </div>

      {confirmShardId ? (
        <StudioShellUnsavedChangesDialog
          onCancel={cancelSwitch}
          onDiscard={discardAndSwitch}
          pendingChanges={pendingChanges}
          targetLabel={
            shards.find((shard) => shard.id === confirmShardId)?.label ??
            confirmShardId
          }
        />
      ) : null}
    </ShellFrame>
  );
}

/**
 * Host chrome wrapper.
 *
 * Carries Studio's `ps` root class so host-owned elements inherit Studio's
 * design tokens, and so Studio's theme hook - which targets every `.ps` element
 * - keeps the shell's light/dark appearance in sync with the Studio inside it.
 */
function ShellFrame(props: { children: React.ReactNode }) {
  return <div className="ps studio-shell">{props.children}</div>;
}

function ShellMessage(props: { detail?: string; title: string }) {
  return (
    <div className="studio-shell__message" role="status">
      <p className="studio-shell__message-title">{props.title}</p>
      {props.detail ? (
        <p className="studio-shell__message-detail">{props.detail}</p>
      ) : null}
    </div>
  );
}
