// The `/bridge` overlay: a live list of every agent this Pi has discovered on the bridge.
//
// Deliberately free of runtime imports. pi-tui is only reachable inside the Pi host (its
// extension loader aliases it), so the key/width helpers are injected by the caller. That
// keeps this file loadable — and unit-testable — anywhere.

export const STALE_AFTER_MS = 60_000;

export interface PanelAgent {
  agentId: string;
  displayName: string;
  project?: string;
  host?: string;
  rooms: Set<string>;
  aliases: Set<string>;
  joinedAt?: number;
  lastSeen?: number;
  /** One-line summary of what the agent is working on (from its heartbeat). */
  task?: string;
}

export interface PanelSelf {
  agentId: string;
  displayName: string;
  host: string;
  project: string;
  rooms: string[];
  aliases?: string[];
  joinedAt?: number;
  task?: string;
}

/** Nerd Font "user" glyph (nf-fa-user) marking the agent running this Pi session. */
export const SELF_ICON = '\uf007';

/** What the panel reads from and asks of the extension. */
export interface PanelSource {
  natsUrl: string;
  self(): PanelSelf;
  connected(): boolean;
  error(): string | undefined;
  agents(): PanelAgent[];
  /** Ask peers to re-announce themselves (registry who-there). */
  refresh(): void;
  join(room: string): void;
}

/** Subset of pi-tui used here; the real functions are passed in from the extension. */
export interface PanelTui {
  matchesKey(data: string, key: string): boolean;
  decodeKittyPrintable?(data: string): string | undefined;
  visibleWidth(text: string): number;
  truncateToWidth(
    text: string,
    width: number,
    ellipsis?: string,
    pad?: boolean
  ): string;
}

/** Subset of Pi's Theme. */
export interface PanelTheme {
  fg(
    color:
      | 'border'
      | 'accent'
      | 'dim'
      | 'muted'
      | 'success'
      | 'warning'
      | 'error'
      | 'text',
    text: string
  ): string;
  bold(text: string): string;
}

export type PanelResult =
  | { action: 'message'; target: string }
  | { action: 'whoami' }
  | undefined;

export type Scope = 'project' | 'all';

export function agentKind(agentId: string): string {
  if (agentId.startsWith('claude-code')) return 'claude';
  if (agentId.startsWith('pi')) return 'pi';
  return 'agent';
}

/** The handle a human would type: first memorable alias, else the display name if it is an id, else the id. */
export function agentLabel(agent: PanelAgent): string {
  const alias = [...agent.aliases][0];
  if (alias) return alias;
  return agent.displayName && agent.displayName !== agent.agentId
    ? agent.displayName
    : agent.agentId;
}

/** The DM target for messages: an alias routes as well as the id and reads better. */
export function messageTarget(agent: PanelAgent): string {
  return [...agent.aliases][0] ?? agent.agentId;
}

export function isStale(agent: PanelAgent, now: number): boolean {
  return agent.lastSeen !== undefined && now - agent.lastSeen > STALE_AFTER_MS;
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

export function inScope(
  agent: PanelAgent,
  scope: Scope,
  project: string
): boolean {
  return (
    scope === 'all' || agent.project === project || agent.rooms.has(project)
  );
}

export function matchesFilter(agent: PanelAgent, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  const hay = [
    agent.agentId,
    agent.displayName,
    agent.host,
    agent.project,
    agent.task,
    ...agent.aliases,
    ...agent.rooms,
  ];
  return hay.some((v) => v?.toLowerCase().includes(f));
}

/** Find an agent by alias, id or display name (exact first, then unique prefix). */
export function findAgent(
  agents: PanelAgent[],
  query: string
): PanelAgent | undefined {
  const q = query.trim().toLowerCase();
  if (!q) return undefined;
  const names = (a: PanelAgent) =>
    [a.agentId, a.displayName, ...a.aliases].map((n) => n.toLowerCase());
  const exact = agents.find((a) => names(a).includes(q));
  if (exact) return exact;
  const prefixed = agents.filter((a) => names(a).some((n) => n.startsWith(q)));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/** Agents grouped by host, this host first, then alphabetically; rows sorted by label. */
export function groupByHost(
  agents: PanelAgent[],
  selfHost: string,
  selfId?: string
): Array<{ host: string; agents: PanelAgent[] }> {
  const groups = new Map<string, PanelAgent[]>();
  for (const a of agents) {
    const h = a.host ?? 'unknown host';
    if (!groups.has(h)) groups.set(h, []);
    groups.get(h)!.push(a);
  }
  return [...groups.entries()]
    .sort(([a], [b]) =>
      a === selfHost ? -1 : b === selfHost ? 1 : a.localeCompare(b)
    )
    .map(([host, list]) => ({
      host,
      // The current session's agent leads its host group; the rest sort by label.
      agents: list.sort((x, y) =>
        x.agentId === selfId
          ? -1
          : y.agentId === selfId
            ? 1
            : agentLabel(x).localeCompare(agentLabel(y))
      ),
    }));
}

/** Rooms of `agent` that we have not joined yet, in a stable order. */
export function joinableRooms(agent: PanelAgent, ourRooms: string[]): string[] {
  return [...agent.rooms].filter((r) => !ourRooms.includes(r)).sort();
}

const LIST_ROWS = 14;
const MAX_WIDTH = 78;

export class BridgePanel {
  focused = false;
  private selectedId: string | undefined;
  private filter = '';
  private filtering = false;
  private scope: Scope = 'project';
  private status = '';
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly source: PanelSource,
    private readonly ui: PanelTui,
    private readonly theme: PanelTheme,
    private readonly done: (result: PanelResult) => void,
    private readonly requestRender: () => void,
    opts: { filter?: string; now?: () => number; liveIntervalMs?: number } = {}
  ) {
    this.now = opts.now ?? Date.now;
    if (opts.filter) {
      this.filter = opts.filter;
      this.scope = 'all';
    }
    // Live: ages tick and newly discovered agents appear while the panel is open.
    if (opts.liveIntervalMs !== 0) {
      this.timer = setInterval(
        () => this.requestRender(),
        opts.liveIntervalMs ?? 1000
      );
      this.timer.unref?.();
    }
  }

  private readonly now: () => number;

  /** Nothing is cached between renders, so there is nothing to invalidate. */
  invalidate(): void {}

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Agents shown, in display order (grouped). */
  /** The agent running this Pi session, shaped like a roster entry. Always online. */
  private selfAgent(): PanelAgent {
    const self = this.source.self();
    return {
      agentId: self.agentId,
      displayName: self.displayName,
      project: self.project,
      host: self.host,
      rooms: new Set(self.rooms),
      aliases: new Set(self.aliases ?? []),
      joinedAt: self.joinedAt,
      lastSeen: this.now(),
      task: self.task,
    };
  }

  private isSelf(agent: PanelAgent | undefined): boolean {
    return agent?.agentId === this.source.self().agentId;
  }

  /** Agents shown, in display order (grouped). Our own agent is always in scope. */
  visibleAgents(): PanelAgent[] {
    const self = this.source.self();
    const others = this.source
      .agents()
      .filter((a) => a.agentId !== self.agentId)
      .filter((a) => inScope(a, this.scope, self.project))
      .filter((a) => matchesFilter(a, this.filter));
    // We are always listed, whatever the scope or filter, as a fixed point of reference.
    const shown = [this.selfAgent(), ...others];
    return groupByHost(shown, self.host, self.agentId).flatMap((g) => g.agents);
  }

  /** Defaults to the first other agent: that is who you most likely want to reach. */
  selected(): PanelAgent | undefined {
    const list = this.visibleAgents();
    return (
      list.find((a) => a.agentId === this.selectedId) ??
      list.find((a) => !this.isSelf(a)) ??
      list[0]
    );
  }

  private move(delta: number): void {
    const list = this.visibleAgents();
    if (list.length === 0) return;
    const current = this.selected();
    const idx = current ? list.indexOf(current) : 0;
    const next = Math.min(list.length - 1, Math.max(0, idx + delta));
    this.selectedId = list[next].agentId;
  }

  private close(result: PanelResult): void {
    this.dispose();
    this.done(result);
  }

  handleInput(data: string): void {
    const k = this.ui;
    if (this.filtering) {
      if (
        k.matchesKey(data, 'escape') ||
        k.matchesKey(data, 'return') ||
        k.matchesKey(data, 'enter')
      ) {
        this.filtering = false;
      } else if (k.matchesKey(data, 'backspace')) {
        this.filter = this.filter.slice(0, -1);
      } else if (k.matchesKey(data, 'up')) {
        this.move(-1);
      } else if (k.matchesKey(data, 'down')) {
        this.move(1);
      } else {
        const ch = printable(data, k);
        if (ch) this.filter += ch;
      }
      this.requestRender();
      return;
    }

    if (k.matchesKey(data, 'escape') || data === 'q')
      return this.close(undefined);
    if (k.matchesKey(data, 'up') || data === 'k') this.move(-1);
    else if (k.matchesKey(data, 'down')) this.move(1);
    else if (k.matchesKey(data, 'return') || k.matchesKey(data, 'enter')) {
      const agent = this.selected();
      if (this.isSelf(agent)) this.status = 'That is you — pick another agent to message';
      else if (agent)
        return this.close({ action: 'message', target: messageTarget(agent) });
    } else if (data === 'w') {
      return this.close({ action: 'whoami' });
    } else if (data === '/') {
      this.filtering = true;
    } else if (data === 'r') {
      this.source.refresh();
      this.status = 'Asked every agent to re-announce…';
    } else if (data === 'a') {
      this.scope = this.scope === 'project' ? 'all' : 'project';
      this.status =
        this.scope === 'all'
          ? 'Showing all agents'
          : `Showing agents in room "${this.source.self().project}"`;
    } else if (data === 'j') {
      this.joinSelected();
    }
    this.requestRender();
  }

  private joinSelected(): void {
    const agent = this.selected();
    if (!agent) return;
    if (this.isSelf(agent)) {
      this.status = 'That is you — pick another agent to join its room';
      return;
    }
    if (!this.source.connected()) {
      this.status = 'Not connected — cannot join a room';
      return;
    }
    const room = joinableRooms(agent, this.source.self().rooms)[0];
    if (!room) {
      this.status =
        agent.rooms.size === 0
          ? `${agentLabel(agent)} has not announced any rooms`
          : `Already in all of ${agentLabel(agent)}'s rooms`;
      return;
    }
    this.source.join(room);
    this.status = `Joined room "${room}"`;
  }

  render(width: number): string[] {
    const t = this.theme;
    const w = Math.max(40, Math.min(width, MAX_WIDTH));
    const inner = w - 4; // "│ " + content + " │"
    const fit = (s: string) => this.ui.truncateToWidth(s, inner, '…', true);
    const row = (s: string) =>
      `${t.fg('border', '│')} ${fit(s)} ${t.fg('border', '│')}`;
    const rule = (left: string, right: string, rawLabel = '') => {
      const label = rawLabel
        ? this.ui.truncateToWidth(rawLabel, w - left.length - right.length, '…')
        : '';
      const fill = Math.max(
        0,
        w - left.length - right.length - this.ui.visibleWidth(label),
      );
      return (
        t.fg('border', left) + label + t.fg('border', '─'.repeat(fill) + right)
      );
    };

    const self = this.source.self();
    const now = this.now();
    const connected = this.source.connected();
    const list = this.visibleAgents();
    const online = list.filter((a) => !this.isSelf(a) && !isStale(a, now)).length;
    const title = ` ${t.bold('Bridge agents')} ${t.fg('dim', '·')} ${t.fg('muted', shortUrl(this.source.natsUrl))} ${t.fg('dim', '·')} ${
      connected
        ? t.fg('success', `${online} online`)
        : t.fg('error', 'disconnected')
    } `;

    const out: string[] = [rule('┌─', '┐', title)];

    if (!connected) {
      out.push(row(''));
      out.push(row(t.fg('error', `Not connected to ${this.source.natsUrl}`)));
      const err = this.source.error();
      if (err) out.push(row(t.fg('dim', err)));
      out.push(
        row(
          t.fg(
            'dim',
            'Check the server is reachable or BRIDGE_NATS_URL, then restart Pi.'
          )
        )
      );
      out.push(row(''));
      out.push(rule('├', '┤'));
      out.push(row(t.fg('dim', 'esc close')));
      out.push(rule('└', '┘'));
      return out;
    }

    const scopeLabel =
      this.scope === 'all' ? 'all agents' : `room ${self.project}`;
    const filterText = this.filtering
      ? `${this.filter}█`
      : this.filter || t.fg('dim', '(press /)');
    out.push(
      row(
        `${t.fg('dim', 'filter:')} ${filterText}   ${t.fg('dim', 'scope:')} ${scopeLabel}`
      )
    );
    out.push(row(''));

    // Flatten groups into lines, then window them so the selected row stays visible.
    const sel = this.selected();
    const lines: Array<{ text: string; agentId?: string }> = [];
    for (const g of groupByHost(list, self.host, self.agentId)) {
      if (lines.length > 0) lines.push({ text: '' });
      lines.push({
        text:
          t.bold(g.host) +
          (g.host === self.host ? t.fg('dim', ' (this host)') : ''),
      });
      for (const a of g.agents) {
        lines.push({
          text: this.agentRow(a, a === sel, now, inner),
          agentId: a.agentId,
        });
        if (a.task)
          lines.push({
            text: t.fg('dim', fit(`     ↳ ${a.task}`)),
            agentId: a.agentId,
          });
      }
    }
    if (!list.some((a) => !this.isSelf(a))) {
      if (lines.length > 0) lines.push({ text: '' });
      lines.push({
        text: t.fg(
          'dim',
          this.filter
            ? 'No other agent matches the filter.'
            : this.scope === 'project'
              ? `No other agent in room "${self.project}" — press a to show all.`
              : 'No other agent discovered yet — press r to ask again.'
        ),
      });
    }
    const selLine = Math.max(
      0,
      lines.findIndex((l) => l.agentId === sel?.agentId)
    );
    const start = Math.min(
      Math.max(0, selLine - Math.floor(LIST_ROWS / 2)),
      Math.max(0, lines.length - LIST_ROWS)
    );
    for (const l of lines.slice(start, start + LIST_ROWS))
      out.push(row(l.text));
    out.push(row(''));

    out.push(rule('├', '┤'));
    if (sel) {
      const label = (s: string) => t.fg('dim', s.padEnd(9));
      out.push(row(`${label('send to')}${t.fg('accent', messageTarget(sel))}`));
      out.push(row(`${label('id')}${sel.agentId}`));
      out.push(
        row(
          `${label('aliases')}${[...sel.aliases].join(', ') || t.fg('dim', '—')}`
        )
      );
      out.push(
        row(
          `${label('rooms')}${[...sel.rooms].sort().join(', ') || t.fg('dim', '—')}`
        )
      );
      const joined = sel.joinedAt
        ? new Date(sel.joinedAt).toTimeString().slice(0, 5)
        : '—';
      const seen = sel.lastSeen
        ? ` ${t.fg('dim', `· last seen ${formatAge(now - sel.lastSeen)} ago`)}`
        : '';
      out.push(row(`${label('joined')}${joined}${seen}`));
      out.push(row(`${label('task')}${sel.task ?? t.fg('dim', '—')}`));
    } else {
      out.push(
        row(
          t.fg(
            'dim',
            `you: ${self.displayName} · ${self.agentId} · ${self.host}`
          )
        )
      );
    }
    if (this.status) out.push(row(t.fg('accent', this.status)));
    out.push(rule('├', '┤'));
    out.push(
      row(
        t.fg(
          'dim',
          this.filtering
            ? 'type to filter  ⏎/esc done  ↑↓ move'
            : '↑↓ move  ⏎ message  j join  a scope  w whoami  / filter  r refresh  esc'
        )
      )
    );
    out.push(rule('└', '┘'));
    return out;
  }

  private agentRow(
    a: PanelAgent,
    selected: boolean,
    now: number,
    inner: number
  ): string {
    const t = this.theme;
    const fit = (s: string, n: number) =>
      this.ui.truncateToWidth(s, n, '…', true);
    const self = this.isSelf(a);
    const stale = isStale(a, now);
    const dot = self
      ? t.fg('accent', SELF_ICON)
      : stale
        ? t.fg('warning', '○')
        : t.fg('success', '●');
    const age = a.lastSeen !== undefined ? formatAge(now - a.lastSeen) : '—';
    // The name column shows the DM target (alias, else agent id) so it can be typed as-is
    // into send; wide enough that a full claude-code-<pid> id is never truncated.
    const nameW = Math.max(12, Math.min(24, inner - 36));
    const name = self
      ? t.fg('accent', fit(messageTarget(a), nameW))
      : fit(messageTarget(a), nameW);
    const cells =
      name +
      ' ' +
      fit(agentKind(a.agentId), 7) +
      ' ' +
      fit(a.project ?? '—', 18) +
      ' ' +
      (self
        ? t.fg('accent', 'you')
        : stale
          ? t.fg('warning', age)
          : t.fg('dim', age));
    return selected
      ? `${t.fg('accent', '▶')} ${dot} ${t.bold(cells)}`
      : `  ${dot} ${cells}`;
  }
}

function printable(data: string, k: PanelTui): string | undefined {
  const kitty = k.decodeKittyPrintable?.(data);
  if (kitty) return kitty;
  return data.length === 1 && data >= ' ' && data !== '\x7f' ? data : undefined;
}

function shortUrl(url: string): string {
  return url.replace(/^nats:\/\//, '').replace(/\.[a-z0-9-]+\.ts\.net/, '');
}
