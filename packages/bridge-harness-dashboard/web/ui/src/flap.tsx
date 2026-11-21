import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

/** Duration of one half-card falling, in ms; the lower leaf lands over 1.6× this. */
const FLIP_MS = 200;
const SOUND_KEY = 'bridge.flapSound';
let audio: AudioContext | undefined;
let lastClick = 0;

/** Whether flaps click as they turn. On by default; the topbar toggle stores the choice. */
export function flapSoundOn(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}
export function setFlapSound(on: boolean) {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {}
  if (on) unlockAudio();
}
/** Browsers start audio only after a gesture, so the first click or key unlocks it. */
function unlockAudio() {
  try {
    audio ??= new AudioContext();
    if (audio.state === 'suspended') void audio.resume();
  } catch {}
}
if (typeof window !== 'undefined') {
  for (const ev of ['pointerdown', 'keydown'])
    window.addEventListener(ev, unlockAudio, { capture: true, passive: true });
}

/** A short filtered noise burst: the snap of a card landing. Tiles turning together share one click. */
function click() {
  if (!audio || audio.state !== 'running' || !flapSoundOn()) return;
  const now = performance.now();
  if (now - lastClick < 18) return;
  lastClick = now;
  try {
    const len = 0.012;
    const buf = audio.createBuffer(1, audio.sampleRate * len, audio.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++)
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 4);
    const src = audio.createBufferSource();
    const gain = audio.createGain();
    const band = audio.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2400 + Math.random() * 900;
    gain.gain.value = 0.18;
    src.buffer = buf;
    src.connect(band).connect(gain).connect(audio.destination);
    src.start();
  } catch {}
}

function half(cls: string, ch: string) {
  const el = document.createElement('span');
  el.className = `tile__half tile__${cls}`;
  const s = document.createElement('span');
  s.textContent = ch;
  el.append(s);
  return el;
}

/**
 * One hinged card. On a change the top half falls forward, its back lands on the
 * bottom half with a small bounce, and the card turns 4 to 6 times (random
 * letters, then the target) like a Solari unit settling. Built with DOM nodes
 * so each leaf's animation restarts cleanly on every turn.
 */
function Tile({ ch, still }: { ch: string; still?: boolean }) {
  const host = useRef<HTMLSpanElement>(null);
  const face = useRef(ch);
  const run = useRef(0);

  useLayoutEffect(() => {
    const el = host.current!;
    el.append(half('top', ch), half('bottom', ch));
  }, []);

  useEffect(() => {
    const el = host.current!;
    const top = el.querySelector('.tile__top > span')!;
    const bottom = el.querySelector('.tile__bottom > span')!;
    const settle = (c: string) => {
      el.querySelectorAll('.tile__leaf-top, .tile__leaf-bot').forEach((n) => n.remove());
      top.textContent = c;
      bottom.textContent = c;
      face.current = c;
    };
    if (ch === face.current) return;
    const id = ++run.current;
    if (still || reducedMotion()) {
      settle(ch);
      return;
    }
    // Digit cards (clock, mail count) only ever show digits on the way.
    const drum = /\d/.test(ch) ? DIGITS : DRUM;
    const path: string[] = [];
    const flips = 4 + Math.floor(Math.random() * 3);
    for (let n = 1; n < flips; n++) {
      let c: string;
      do c = drum[Math.floor(Math.random() * drum.length)];
      while (c === ch || c === ' ' || c === (path.at(-1) ?? face.current));
      path.push(c);
    }
    path.push(ch);
    const step = (i: number) => {
      if (id !== run.current) return;
      if (i >= path.length) return;
      const cur = face.current;
      const next = path[i];
      top.textContent = next; // revealed behind the falling leaf
      const lt = half('leaf-top', cur);
      const lb = half('leaf-bot', next);
      el.append(lt, lb);
      setTimeout(click, FLIP_MS * 1.5);
      lb.addEventListener('animationend', (e) => {
        if (e.animationName !== 'leaf-land') return;
        bottom.textContent = next;
        lt.remove();
        lb.remove();
        face.current = next;
        step(i + 1);
      });
    };
    // A newer value cancels the turn in flight: snap to a clean card first.
    settle(face.current);
    step(0);
    return () => {
      if (run.current === id) run.current++;
    };
  }, [ch]);

  return <span class="tile" ref={host} />;
}

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
    // Tiles turn themselves; only the inline text flap rolls here.
    if (cells || still || reducedMotion()) {
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
          ? [...target].map((ch, i) => (
              <Tile key={i} ch={ch} still={still} />
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
