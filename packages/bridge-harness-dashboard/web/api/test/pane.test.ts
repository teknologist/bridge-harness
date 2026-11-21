import { describe, expect, it } from 'vitest';
import { createPanes, type RexRun } from '../src/pane.ts';
import { rexBlock } from '../src/fleet.ts';

// A fake Rex: the block lives on one server; other servers answer "not found".
function fakeRex(home: string, screen = 'line 1\nDo you want to proceed?\n❯ 1. Yes\n') {
  const calls: string[][] = [];
  const run: RexRun = async (args) => {
    calls.push(args);
    const server = args[0] === '-S' ? args[1] : '';
    if (server !== home) throw new Error('block target not found');
    return args.includes('capture') ? screen : '';
  };
  return { run, calls };
}

describe('panes', () => {
  it('finds a pane on a remote host and remembers where it is', async () => {
    const rex = fakeRex('spark1');
    const panes = createPanes(rex.run, async () => ['Glod', 'spark1']);
    const first = await panes.screen('block:a');
    expect(first).toEqual({ text: 'line 1\nDo you want to proceed?\n❯ 1. Yes', server: 'spark1' });
    rex.calls.length = 0;
    await panes.screen('block:a');
    expect(rex.calls).toEqual([['-S', 'spark1', 'capture', '-b', 'block:a', '--trim']]);
  });

  it('types text before keys, on the server that holds the pane', async () => {
    const rex = fakeRex('');
    const panes = createPanes(rex.run, async () => []);
    await panes.type('block:b', 'use the staging db', ['enter']);
    expect(rex.calls.slice(-2)).toEqual([
      ['send', '-b', 'block:b', '--', 'use the staging db'],
      ['send-key', '-b', 'block:b', 'enter'],
    ]);
  });

  it('keeps only the bottom of a long screen, where the prompt is', async () => {
    const long = Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n');
    const panes = createPanes(fakeRex('', long).run, async () => []);
    const { text, server } = await panes.screen('block:c');
    expect(server).toBeUndefined();
    expect(text.split('\n')).toHaveLength(60);
    expect(text.endsWith('l199')).toBe(true);
  });

  it('closes the pane on the server that holds it, which ends the agent', async () => {
    const rex = fakeRex('spark1');
    const panes = createPanes(rex.run, async () => ['spark1']);
    await panes.close('block:e');
    expect(rex.calls.at(-1)).toEqual(['-S', 'spark1', 'block', 'close', 'block:e']);
  });

  it('fails when no server has the pane', async () => {
    const panes = createPanes(fakeRex('nowhere').run, async () => ['Glod']);
    await expect(panes.screen('block:d')).rejects.toThrow(/not found/);
  });
});

// A pane id is published by the agent itself and ends up as `rex -b <id>`, so only a
// real block id may pass; anything else means "no pane" rather than an odd rex argument.
describe('rexBlock', () => {
  it('keeps Rex block ids and drops anything else', () => {
    expect(rexBlock('block:01a1febd-b936-7eff-9c1d-32f3a3c14d90')).toBe('block:01a1febd-b936-7eff-9c1d-32f3a3c14d90');
    expect(rexBlock('--server=evil')).toBeUndefined();
    expect(rexBlock('block:a b')).toBeUndefined();
    expect(rexBlock(undefined)).toBeUndefined();
  });
});
