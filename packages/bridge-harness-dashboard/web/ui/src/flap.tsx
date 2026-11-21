import { useEffect, useRef, useState } from 'preact/hooks';

/** Characters past this index appear without a flip, so long tasks don't ripple for seconds. */
const MAX_FLIPPED = 28;
/** Drum order of a split-flap unit: a changing character rolls through these before it lands. */
const DRUM = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const TICK_MS = 55;
/** Digit flaps (clock) carry only digits, so a changing digit never shows a letter. */
const DIGITS = '0123456789';

function roll(from: string, to: string, step: number) {
  const drum = /\d/.test(from) && /\d/.test(to) ? DIGITS : DRUM;
  const at = Math.max(0, drum.indexOf(from.toUpperCase()));
  return drum[(at + step) % drum.length];
}

interface FlapProps {
  value: string;
  /** Amber text: the value changed and the operator has not opened this row yet. */
  pending?: boolean;
  tone?: 'default' | 'live' | 'stale' | 'mail' | 'muted';
  /** Draw each character on its own tile, padded on the left to this many cells, so words sit flush right like a departures board. */
  cells?: number;
  /** Changes land without rolling, for values that tick on their own (seen, clock seconds). */
  still?: boolean;
  class?: string;
  title?: string;
}

const reducedMotion = () =>
  typeof matchMedia === 'function' &&
  matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A departure-board flap. When `value` changes after first render, each changed
 * character rolls through the drum and lands, staggered left to right, like a
 * Solari board. The first render never moves, so loading the board is quiet.
 */
export function Flap({
  value,
  pending,
  tone = 'default',
  cells,
  still,
  class: cls,
  title,
}: FlapProps) {
  const target = cells ? value.slice(0, cells).padStart(cells, ' ') : value;
  const [shown, setShown] = useState(target);
  const [rolling, setRolling] = useState(false);
  const from = useRef(target);

  useEffect(() => {
    const start = from.current;
    from.current = target;
    if (start === target) return;
    if (still || reducedMotion()) {
      setShown(target);
      return;
    }
    // Each changed character rolls a few steps past where it started, then lands.
    const land = [...target].map((ch, i) =>
      i >= MAX_FLIPPED || ch === start[i]
        ? 0
        : 3 + i + Math.floor(Math.random() * 3)
    );
    const last = Math.max(...land);
    let step = 0;
    setRolling(true);
    const timer = setInterval(() => {
      step++;
      setShown(
        [...target]
          .map((ch, i) =>
            step >= land[i]
              ? ch
              : roll(start[i] ?? ' ', ch, step + 1)
          )
          .join('')
      );
      if (step >= last) {
        clearInterval(timer);
        setRolling(false);
      }
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [target]);

  const classes = [
    'flap',
    `flap--${tone}`,
    cells ? 'flap--tiles' : '',
    pending ? 'flap--pending' : '',
    rolling ? 'flap--rolling' : '',
    cls ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const chars = [...shown];
  return (
    <span class={classes} title={title ?? value}>
      <span class="flap__text" aria-hidden="true">
        {cells
          ? chars.map((ch, i) => (
              <span class="flap__tile" key={`${i}${ch}`}>
                {ch}
              </span>
            ))
          : rolling
            ? chars.map((ch, i) =>
                i < MAX_FLIPPED ? (
                  <span class="flap__ch" key={`${i}${ch}`}>
                    {ch}
                  </span>
                ) : (
                  ch
                )
              )
            : shown}
      </span>
      <span class="sr-only">{value}</span>
    </span>
  );
}
