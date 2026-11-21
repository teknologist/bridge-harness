// Reads and types into an agent's terminal pane through the Rex CLI, so the board can
// answer a prompt the agent is blocked on. An agent publishes its Rex block id; the
// block may live on this machine or on any `rex hosts` server, so the first lookup
// tries each and remembers where it found it.
import { execFile } from 'node:child_process';
import type { PaneKey } from '../../../shared/contract.ts';

/** Runs `rex <args>` and resolves stdout; rejects on a non-zero exit. */
export type RexRun = (args: string[]) => Promise<string>;

export function rexRunner(bin: string): RexRun {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { encoding: 'utf8', timeout: 8_000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) reject(new Error((stderr || err.message).trim()));
          else resolve(stdout);
        }
      );
    });
}

const ESCAPES = /\x1b\[[0-9;?]*[A-Za-z]/g;
const visible = (line: string) => line.replace(ESCAPES, '').trim() !== '';

/** Keeps the tail of a capture: a prompt sits at the bottom of the screen. */
const SCREEN_LINES = 60;

export function createPanes(run: RexRun, hosts: () => Promise<string[]>) {
  // block id → '' for the local server, else a host label.
  const where = new Map<string, string>();
  const serverArgs = (server: string) => (server ? ['-S', server] : []);

  async function capture(block: string, server: string) {
    return run([...serverArgs(server), 'capture', '-b', block, '--trim', '--format', 'vt']);
  }

  async function locate(
    block: string
  ): Promise<{ server: string; text: string }> {
    const known = where.get(block);
    if (known !== undefined) {
      try {
        return { server: known, text: await capture(block, known) };
      } catch {
        where.delete(block);
      }
    }
    for (const server of ['', ...(await hosts())]) {
      try {
        const text = await capture(block, server);
        where.set(block, server);
        return { server, text };
      } catch {
        /* not on this server */
      }
    }
    throw new Error('pane not found on any Rex server');
  }

  return {
    async screen(block: string) {
      const { server, text } = await locate(block);
      // VT capture: lines keep their SGR colour codes for the UI to paint.
      const lines = text.split(/\r?\n/);
      while (lines.length && !visible(lines[lines.length - 1])) lines.pop();
      return {
        text: lines.slice(-SCREEN_LINES).join('\n'),
        server: server || undefined,
      };
    },
    async type(block: string, text: string | undefined, keys: PaneKey[]) {
      if (!where.has(block)) await locate(block);
      const server = serverArgs(where.get(block) ?? '');
      if (text) await run([...server, 'send', '-b', block, '--', text]);
      if (keys.length) await run([...server, 'send-key', '-b', block, ...keys]);
    },
    /** Closes the pane, which ends the agent running in it. */
    async close(block: string) {
      const { server } = await locate(block);
      await run([...serverArgs(server), 'block', 'close', block]);
      where.delete(block);
    },
  };
}
