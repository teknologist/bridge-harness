import { useEffect, useRef, useState } from 'preact/hooks';

/** Characters past this index appear without a flip, so long tasks don't ripple for seconds. */
const MAX_FLIPPED = 28;

interface FlapProps {
  value: string;
  /** Amber outline: the value changed and the operator has not opened this row yet. */
  pending?: boolean;
  tone?: 'default' | 'live' | 'stale' | 'mail' | 'muted';
  class?: string;
  title?: string;
}

/**
 * A departure-board flap. When `value` changes after first render, its characters
 * flip in once, left to right. The first render never animates, so loading the
 * board is quiet and only real changes move.
 */
export function Flap({
  value,
  pending,
  tone = 'default',
  class: cls,
  title,
}: FlapProps) {
  const first = useRef(true);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setGeneration((g) => g + 1);
  }, [value]);

  const flipping = generation > 0;
  const classes = [
    'flap',
    `flap--${tone}`,
    pending ? 'flap--pending' : '',
    cls ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span class={classes} title={title ?? value}>
      <span
        class="flap__text"
        key={generation}
        aria-hidden={flipping ? 'true' : undefined}
      >
        {flipping
          ? [...value].map((ch, i) =>
              i < MAX_FLIPPED ? (
                <span
                  class="flap__ch"
                  style={{ animationDelay: `${i * 22}ms` }}
                >
                  {ch === ' ' ? ' ' : ch}
                </span>
              ) : (
                ch
              )
            )
          : value}
      </span>
      {flipping ? <span class="sr-only">{value}</span> : null}
    </span>
  );
}
