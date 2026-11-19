import { describe, expect, it, vi } from 'vitest';
import {
  BridgePanel,
  findAgent,
  groupByHost,
  type PanelAgent,
  type PanelResult,
  type PanelSource,
  type PanelTui,
} from '../../packages/bridge-harness-pi/src/bridge-panel.js';

// Minimal stand-ins for pi-tui and Pi's theme: the panel only needs key matching and widths.
const KEYS: Record<string, string> = {
  escape: '\x1b',
  return: '\r',
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  backspace: '\x7f',
};
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const tui: PanelTui = {
  matchesKey: (data, key) => KEYS[key] === data,
  visibleWidth: (s) => strip(s).length,
  truncateToWidth: (s, w, ellipsis = '', pad = false) => {
    const plain = strip(s);
    const cut =
      plain.length > w ? plain.slice(0, w - ellipsis.length) + ellipsis : plain;
    return pad ? cut.padEnd(w) : cut;
  },
};
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

const NOW = 1_000_000;
function agent(id: string, extra: Partial<PanelAgent> = {}): PanelAgent {
  return {
    agentId: id,
    displayName: id,
    rooms: new Set(),
    aliases: new Set(),
    lastSeen: NOW - 1000,
    joinedAt: NOW - 60_000,
    ...extra,
  };
}

function setup(
  agents: PanelAgent[],
  opts: { connected?: boolean; filter?: string } = {}
) {
  const joined: string[] = [];
  const rooms = ['pa-api'];
  const source: PanelSource = {
    natsUrl: 'nats://glod.example.ts.net:4222',
    self: () => ({
      agentId: 'pi-me',
      displayName: 'me',
      host: 'mac',
      project: 'pa-api',
      rooms,
    }),
    connected: () => opts.connected ?? true,
    error: () => 'ECONNREFUSED',
    agents: () => agents,
    refresh: vi.fn(),
    join: (room) => {
      joined.push(room);
      rooms.push(room);
    },
  };
  let result: PanelResult | 'open' = 'open';
  const panel = new BridgePanel(
    source,
    tui,
    theme,
    (r) => {
      result = r;
    },
    () => {},
    { filter: opts.filter, now: () => NOW, liveIntervalMs: 0 }
  );
  return {
    panel,
    source,
    joined,
    result: () => result,
    text: () => panel.render(80).map(strip).join('\n'),
  };
}

const roster = [
  agent('pi-me', { project: 'pa-api', host: 'mac' }),
  agent('pi-mac-1', {
    project: 'pa-api',
    host: 'mac',
    aliases: new Set(['planner']),
    rooms: new Set(['pa-api', 'release']),
  }),
  agent('claude-code-41', {
    project: 'invoices-scraper',
    host: 'glod',
    rooms: new Set(['invoices-scraper']),
  }),
  agent('pi-glod-2', {
    project: 'pa-api',
    host: 'glod',
    aliases: new Set(['reviewer']),
    lastSeen: NOW - 94_000,
  }),
];

describe('/bridge panel', () => {
  it('lists only agents in our project by default, never ourselves, this host first', () => {
    const { panel, text } = setup(roster);
    expect(panel.visibleAgents().map((a) => a.agentId)).toEqual([
      'pi-mac-1',
      'pi-glod-2',
    ]);
    const out = text();
    expect(out).not.toContain('pi-me ');
    expect(out.indexOf('│ mac (this host)')).toBeLessThan(out.indexOf('│ glod'));
  });

  it('toggles to all agents with a', () => {
    const { panel } = setup(roster);
    panel.handleInput('a');
    expect(panel.visibleAgents().map((a) => a.agentId)).toContain(
      'claude-code-41'
    );
  });

  it('marks agents silent for over a minute as stale, so the user knows a reply is unlikely', () => {
    const { text } = setup(roster);
    const line = text()
      .split('\n')
      .find((l) => l.includes('reviewer'))!;
    expect(line).toContain('○');
    expect(line).toContain('1m');
  });

  it("enter returns the selected agent's alias as the message target (nothing is sent)", () => {
    const { panel, result } = setup(roster);
    panel.handleInput('\r');
    expect(result()).toEqual({ action: 'message', target: 'planner' });
  });

  it('down moves the selection; target falls back to the id when there is no alias', () => {
    const { panel, result } = setup(roster);
    panel.handleInput('a');
    panel.handleInput('\x1b[B'); // mac → first glod agent (sorted: claude-code-41)
    panel.handleInput('\r');
    expect(result()).toEqual({ action: 'message', target: 'claude-code-41' });
  });

  it('j joins the first room of the selected agent we are not already in', () => {
    const { panel, joined, text } = setup(roster);
    panel.handleInput('j');
    expect(joined).toEqual(['release']);
    expect(text()).toContain('Joined room "release"');
    panel.handleInput('j');
    expect(joined).toEqual(['release']);
    expect(text()).toContain("Already in all of planner's rooms");
  });

  it('filter narrows by any field and switches off when done', () => {
    const { panel } = setup(roster);
    panel.handleInput('a');
    panel.handleInput('/');
    for (const ch of 'glod') panel.handleInput(ch);
    panel.handleInput('\r');
    expect(
      panel
        .visibleAgents()
        .map((a) => a.agentId)
        .sort()
    ).toEqual(['claude-code-41', 'pi-glod-2']);
    panel.handleInput('q');
  });

  it('an initial filter (from /bridge <name>) searches all agents', () => {
    const { panel } = setup(roster, { filter: 'claude' });
    expect(panel.visibleAgents().map((a) => a.agentId)).toEqual([
      'claude-code-41',
    ]);
  });

  it('r asks peers to re-announce; w and esc close', () => {
    const s = setup(roster);
    s.panel.handleInput('r');
    expect(s.source.refresh).toHaveBeenCalled();
    s.panel.handleInput('w');
    expect(s.result()).toEqual({ action: 'whoami' });
    const e = setup(roster);
    e.panel.handleInput('\x1b');
    expect(e.result()).toBeUndefined();
  });

  it('shows the URL and error instead of an empty list when disconnected', () => {
    const out = setup(roster, { connected: false }).text();
    expect(out).toContain('Not connected to nats://glod.example.ts.net:4222');
    expect(out).toContain('ECONNREFUSED');
  });

  it('never renders a line wider than the terminal', () => {
    const { panel } = setup(roster);
    for (const w of [40, 60, 80, 120]) {
      for (const line of panel.render(w))
        expect(strip(line).length).toBeLessThanOrEqual(w);
    }
  });
});

describe('findAgent', () => {
  it('matches alias, id or unique prefix; ambiguous prefixes match nothing', () => {
    expect(findAgent(roster, 'planner')?.agentId).toBe('pi-mac-1');
    expect(findAgent(roster, 'claude')?.agentId).toBe('claude-code-41');
    expect(findAgent(roster, 'pi-')).toBeUndefined();
  });
});

describe('groupByHost', () => {
  it("puts agents without a host under 'unknown host'", () => {
    expect(groupByHost([agent('x')], 'mac')[0].host).toBe('unknown host');
  });
});
