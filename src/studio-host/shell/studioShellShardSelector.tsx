import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { StudioShardManifestEntry } from '../studioHostManifest';

/**
 * Shard picker rendered into Studio's host header slot.
 *
 * Built as a listbox rather than a native `<select>` so each option can carry a
 * status indicator, and implemented directly against the WAI-ARIA
 * collapsed-listbox pattern: roving focus lives on the button, `aria-activedescendant`
 * tracks the highlighted option, and the current selection is announced.
 *
 * Status is never communicated by colour alone - every state also has a shape
 * and a text label - and all motion is suppressed under `prefers-reduced-motion`.
 */

export interface StudioShellShardSelectorProps {
  shards: StudioShardManifestEntry[];
  activeShardId: string | null;
  /** True while a switch is being applied, including introspection. */
  isSwitching: boolean;
  /** Shard the user asked for while a switch is in progress. */
  pendingShardId: string | null;
  onSelect: (shardId: string) => void;
}

const STATUS_LABEL: Record<StudioShardManifestEntry['status'], string> = {
  unknown: 'Status not checked',
  checking: 'Checking connection',
  available: 'Connected',
  unavailable: 'Unreachable',
};

/**
 * Shape carries the meaning; colour only reinforces it. Screen readers get the
 * text from {@link STATUS_LABEL} instead of the glyph.
 */
const STATUS_GLYPH: Record<StudioShardManifestEntry['status'], string> = {
  unknown: '○',
  checking: '◐',
  available: '●',
  unavailable: '▲',
};

function StatusIndicator(props: { status: StudioShardManifestEntry['status'] }) {
  return (
    <span
      aria-hidden="true"
      className={`shard-selector__status shard-selector__status--${props.status}`}
    >
      {STATUS_GLYPH[props.status]}
    </span>
  );
}

export function StudioShellShardSelector(props: StudioShellShardSelectorProps) {
  const { shards, activeShardId, isSwitching, pendingShardId, onSelect } = props;

  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  const activeShard = shards.find((shard) => shard.id === activeShardId);
  const displayShard =
    shards.find((shard) => shard.id === pendingShardId) ?? activeShard;

  const close = useCallback((returnFocus = true) => {
    setIsOpen(false);

    if (returnFocus) {
      buttonRef.current?.focus();
    }
  }, []);

  const open = useCallback(() => {
    const activeIndex = shards.findIndex((shard) => shard.id === activeShardId);
    setHighlightedIndex(activeIndex >= 0 ? activeIndex : 0);
    setIsOpen(true);
  }, [activeShardId, shards]);

  const commit = useCallback(
    (index: number) => {
      const shard = shards[index];

      if (!shard) {
        return;
      }

      close();

      // An unreachable shard is still selectable: the user needs a way to
      // retry it, and a failed shard must not become unreachable in the UI too.
      if (shard.id !== activeShardId) {
        onSelect(shard.id);
      }
    },
    [activeShardId, close, onSelect, shards]
  );

  // Dismiss on outside interaction, matching every other Studio popover.
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;

      if (
        !buttonRef.current?.contains(target) &&
        !listRef.current?.contains(target)
      ) {
        close(false);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [close, isOpen]);

  // Keep the highlighted option in view during keyboard navigation.
  useEffect(() => {
    if (!isOpen) {
      return;
    }

    // Addressed by position rather than by generated id so this effect depends
    // only on values that actually change.
    listRef.current?.children[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, isOpen]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (shards.length === 0) {
      return;
    }

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();

        if (!isOpen) {
          open();
          return;
        }

        const delta = event.key === 'ArrowDown' ? 1 : -1;
        setHighlightedIndex(
          (current) => (current + delta + shards.length) % shards.length
        );
        return;
      }

      case 'Home':
        if (isOpen) {
          event.preventDefault();
          setHighlightedIndex(0);
        }
        return;

      case 'End':
        if (isOpen) {
          event.preventDefault();
          setHighlightedIndex(shards.length - 1);
        }
        return;

      case 'Enter':
      case ' ':
      case 'Spacebar':
        event.preventDefault();

        if (isOpen) {
          commit(highlightedIndex);
          return;
        }

        open();
        return;

      case 'Escape':
        if (isOpen) {
          event.preventDefault();
          close();
        }
        return;

      case 'Tab':
        if (isOpen) {
          close(false);
        }
        return;

      default:
        return;
    }
  };

  const buttonLabel = displayShard
    ? `Database: ${displayShard.label}. ${STATUS_LABEL[displayShard.status]}.`
    : 'Select a database';

  return (
    <div className="shard-selector">
      <button
        aria-controls={isOpen ? listboxId : undefined}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-label={buttonLabel}
        className="shard-selector__trigger"
        data-testid="shard-selector-trigger"
        disabled={shards.length === 0}
        onClick={() => (isOpen ? close(false) : open())}
        onKeyDown={onKeyDown}
        ref={buttonRef}
        type="button"
      >
        <StatusIndicator status={displayShard?.status ?? 'unknown'} />
        <span className="shard-selector__label">
          {displayShard?.label ?? 'No database'}
        </span>
        {isSwitching ? (
          <span className="shard-selector__spinner" aria-hidden="true" />
        ) : (
          <span aria-hidden="true" className="shard-selector__chevron">
            ▾
          </span>
        )}
      </button>

      {isOpen ? (
        <ul
          aria-activedescendant={optionId(highlightedIndex)}
          aria-label="Databases"
          className="shard-selector__list"
          id={listboxId}
          onKeyDown={onKeyDown}
          ref={listRef}
          role="listbox"
          tabIndex={-1}
        >
          {shards.map((shard, index) => {
            const isSelected = shard.id === activeShardId;

            return (
              <li
                aria-selected={isSelected}
                className="shard-selector__option"
                data-highlighted={index === highlightedIndex || undefined}
                data-selected={isSelected || undefined}
                id={optionId(index)}
                key={shard.id}
                onClick={() => commit(index)}
                onMouseEnter={() => setHighlightedIndex(index)}
                role="option"
                title={shard.label}
              >
                <StatusIndicator status={shard.status} />
                <span className="shard-selector__option-label">{shard.label}</span>
                <span className="shard-selector__option-status">
                  {isSelected ? 'Current' : STATUS_LABEL[shard.status]}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {/*
       * Selection changes are driven by pointer and keyboard alike, so the
       * result is announced from a live region rather than relying on focus
       * landing somewhere informative.
       */}
      <span aria-live="polite" className="shard-selector__announcement">
        {isSwitching && pendingShardId
          ? `Switching to ${
              shards.find((shard) => shard.id === pendingShardId)?.label ??
              pendingShardId
            }`
          : activeShard
            ? `Showing ${activeShard.label}`
            : ''}
      </span>
    </div>
  );
}
