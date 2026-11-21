// Paints a VT capture (text with SGR escape codes) as coloured spans, so the
// terminal pane looks like the agent's real terminal. Only colour and weight
// are kept; cursor moves other than "forward N" are dropped.
import type { JSX } from 'preact';

type Style = {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
};

// xterm's default 16 colours, tuned to sit on the near-black pane.
const BASE = [
  '#3b3f45',
  '#e06c75',
  '#98c379',
  '#e5c07b',
  '#61afef',
  '#c678dd',
  '#56b6c2',
  '#c8ccd2',
  '#6b717a',
  '#ef8189',
  '#b5e08f',
  '#f2d08f',
  '#7cc0f5',
  '#d690e8',
  '#6fcfda',
  '#f2f4f7',
];

function xterm256(n: number): string {
  if (n < 16) return BASE[n];
  if (n < 232) {
    const i = n - 16;
    const step = (v: number) => (v === 0 ? 0 : 55 + v * 40);
    return `rgb(${step(Math.floor(i / 36))} ${step(Math.floor(i / 6) % 6)} ${step(i % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g} ${g} ${g})`;
}

/** Applies one SGR parameter list to a style; returns the new style. */
function apply(style: Style, params: number[]): Style {
  const s = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) Object.keys(s).forEach((k) => delete s[k as keyof Style]);
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 9) s.strike = true;
    else if (p === 22) s.bold = s.dim = false;
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p === 29) s.strike = false;
    else if (p >= 30 && p <= 37) s.fg = BASE[p - 30];
    else if (p >= 90 && p <= 97) s.fg = BASE[p - 90 + 8];
    else if (p === 39) delete s.fg;
    else if (p >= 40 && p <= 47) s.bg = BASE[p - 40];
    else if (p >= 100 && p <= 107) s.bg = BASE[p - 100 + 8];
    else if (p === 49) delete s.bg;
    else if (p === 38 || p === 48) {
      const key = p === 38 ? 'fg' : 'bg';
      if (params[i + 1] === 2 && i + 4 < params.length) {
        s[key] = `rgb(${params[i + 2]} ${params[i + 3]} ${params[i + 4]})`;
        i += 4;
      } else if (params[i + 1] === 5 && i + 2 < params.length) {
        s[key] = xterm256(params[i + 2]);
        i += 2;
      }
    }
  }
  return s;
}

function css(s: Style): Record<string, string | number> | undefined {
  let fg = s.fg;
  let bg = s.bg;
  if (s.inverse) [fg, bg] = [bg ?? '#050506', fg ?? '#c8ccd2'];
  const out: Record<string, string | number> = {};
  if (fg) out.color = fg;
  if (bg) out.backgroundColor = bg;
  if (s.bold) out.fontWeight = 600;
  if (s.dim) out.opacity = 0.6;
  if (s.italic) out.fontStyle = 'italic';
  const deco = [s.underline && 'underline', s.strike && 'line-through'].filter(
    Boolean
  );
  if (deco.length) out.textDecoration = deco.join(' ');
  return Object.keys(out).length ? out : undefined;
}

const CSI = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\r/g;

/** Splits a VT capture into styled runs, ready to render inside a <pre>. */
export function ansiSpans(text: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  let style: Style = {};
  let buf = '';
  let key = 0;
  const flush = () => {
    if (!buf) return;
    out.push(
      <span key={key++} style={css(style)}>
        {buf}
      </span>
    );
    buf = '';
  };
  let last = 0;
  for (const m of text.matchAll(CSI)) {
    buf += text.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    if (m[2] === 'm') {
      flush();
      style = apply(
        style,
        (m[1] || '0').split(';').map((n) => Number(n) || 0)
      );
    } else if (m[2] === 'C') {
      buf += ' '.repeat(Math.min(Number(m[1]) || 1, 400));
    }
  }
  buf += text.slice(last);
  flush();
  return out;
}
