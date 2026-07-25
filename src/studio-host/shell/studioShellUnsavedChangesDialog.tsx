import React, { useEffect, useRef } from 'react';

/**
 * Confirmation shown when switching databases would abandon staged work.
 *
 * The host deliberately does not offer to save on the user's behalf: committing
 * staged rows is a per-table Studio action with its own validation and error
 * handling, and a host-driven "save everything" would hide failures behind a
 * dialog. Instead the user is returned to their edits to save them there, or
 * discards them explicitly. Nothing is ever dropped silently.
 */

export interface StudioShellUnsavedChangesDialogProps {
  pendingChanges: {
    stagedRowCount: number;
    stagedUpdateCount: number;
  };
  targetLabel: string;
  onCancel: () => void;
  onDiscard: () => void;
}

const describe = (props: StudioShellUnsavedChangesDialogProps): string => {
  const { stagedRowCount, stagedUpdateCount } = props.pendingChanges;
  const parts: string[] = [];

  if (stagedRowCount > 0) {
    parts.push(`${stagedRowCount} new ${stagedRowCount === 1 ? 'row' : 'rows'}`);
  }

  if (stagedUpdateCount > 0) {
    parts.push(
      `${stagedUpdateCount} edited ${stagedUpdateCount === 1 ? 'row' : 'rows'}`
    );
  }

  return parts.join(' and ');
};

export function StudioShellUnsavedChangesDialog(
  props: StudioShellUnsavedChangesDialogProps
) {
  const { onCancel, onDiscard, targetLabel } = props;
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // The safe choice takes focus, so an accidental Enter keeps the edits.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Focus stays inside the dialog while it is open, and Escape is the same as
  // cancelling.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }

      if (event.key !== 'Tab') {
        return;
      }

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button');

      if (!focusable || focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }

      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  const summary = describe(props);

  return (
    <div className="studio-shell__dialog-backdrop">
      <div
        aria-describedby="shard-switch-description"
        aria-labelledby="shard-switch-title"
        aria-modal="true"
        className="studio-shell__dialog"
        data-testid="shard-switch-confirmation"
        ref={dialogRef}
        role="alertdialog"
      >
        <h2 className="studio-shell__dialog-title" id="shard-switch-title">
          You have unsaved changes
        </h2>
        <p className="studio-shell__dialog-body" id="shard-switch-description">
          {summary
            ? `${summary} have not been saved to the current database. `
            : 'You have unsaved changes in the current database. '}
          Switching to {targetLabel} will discard them.
        </p>
        <div className="studio-shell__dialog-actions">
          <button
            className="studio-shell__button studio-shell__button--primary"
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            Keep editing
          </button>
          <button
            className="studio-shell__button studio-shell__button--destructive"
            onClick={onDiscard}
            type="button"
          >
            Discard and switch
          </button>
        </div>
      </div>
    </div>
  );
}
