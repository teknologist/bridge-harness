import type { DirsResponse } from '../../../shared/contract.ts';
import type { RexRun } from './pane.ts';

/**
 * Lists the folders under `path` on this machine or a Rex host, for the spawn dialog's
 * directory picker. Rex's terminal list_dir action does the reading, so a remote host
 * needs nothing installed beyond its Rex server. `~` expands on the target machine.
 */
export async function listDirs(run: RexRun, host: string | undefined, path: string, prefix = ''): Promise<DirsResponse> {
  const args = [...(host ? ['-S', host] : []), 'do', 'com.superlogical.terminal.list_dir', `path=${path || '~'}`, 'limit=500'];
  if (prefix) args.push(`prefix=${prefix}`);
  const out = JSON.parse(await run(args)) as {
    path?: string; home?: string; status?: string; truncated?: boolean;
    entries?: Array<{ name: string; file?: boolean }>;
  };
  if (out.status === 'missing') return { path: out.path ?? path, home: out.home ?? '', exists: false, dirs: [], truncated: false };
  if (out.status !== 'ok') throw new Error(`${out.path ?? path}: ${out.status ?? 'unreadable'}`);
  const dirs = (out.entries ?? [])
    .filter((e) => !e.file)
    .map((e) => e.name)
    .sort((a, b) => Number(a.startsWith('.')) - Number(b.startsWith('.')) || a.localeCompare(b));
  return { path: out.path ?? path, home: out.home ?? '', exists: true, dirs, truncated: Boolean(out.truncated) };
}
