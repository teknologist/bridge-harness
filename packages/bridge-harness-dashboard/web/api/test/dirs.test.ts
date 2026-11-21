import { describe, expect, it } from 'vitest';
import { listDirs } from '../src/dirs.ts';
import type { RexRun } from '../src/pane.ts';

const rex = (reply: object) => {
  const calls: string[][] = [];
  const run: RexRun = async (args) => (calls.push(args), JSON.stringify(reply));
  return { run, calls };
};

describe('listDirs', () => {
  // The picker browses folders, so files are dropped and dot-folders sink below the rest.
  it('keeps folders only, hidden ones last, asking the chosen host', async () => {
    const r = rex({ path: '/home/e', home: '/home/e', status: 'ok', truncated: false,
      entries: [{ name: '.cache' }, { name: 'notes.md', file: true }, { name: 'Dev' }, { name: 'apps' }] });
    const out = await listDirs(r.run, 'spark1', '~', 'a');
    expect(out).toEqual({ path: '/home/e', home: '/home/e', exists: true, dirs: ['apps', 'Dev', '.cache'], truncated: false });
    expect(r.calls[0]).toEqual(['-S', 'spark1', 'do', 'com.superlogical.terminal.list_dir', 'path=~', 'limit=500', 'prefix=a']);
  });

  // A mistyped path is normal while typing: report it, don't fail the request.
  it('reports a missing folder instead of throwing', async () => {
    const out = await listDirs(rex({ path: '/nope', home: '/h', status: 'missing', entries: [] }).run, undefined, '/nope');
    expect(out.exists).toBe(false);
  });
});
