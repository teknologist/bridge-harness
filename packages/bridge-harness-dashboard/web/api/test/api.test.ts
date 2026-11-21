import { randomUUID } from 'node:crypto';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from '../src/index.ts';
import { openHistory } from '../src/history.ts';

const token = randomUUID();
const headers = { authorization: `Bearer ${token}` };
let directory: string;
let app: Awaited<ReturnType<typeof create>> | undefined;
const offline = async () => { throw new Error('NATS offline'); };

beforeEach(async () => {
  vi.stubEnv('BRIDGE_DASHBOARD_TOKEN', token);
  directory = await mkdtemp(join(tmpdir(), 'bridge-dashboard-test-'));
});
afterEach(async () => {
  await app?.close();
  app = undefined;
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const start = () => create({ dataDirectory: directory, dial: offline });

describe('dashboard HTTP API', () => {
  it('refuses startup without a token', async () => {
    vi.stubEnv('BRIDGE_DASHBOARD_TOKEN', undefined);
    await expect(start()).rejects.toThrow('BRIDGE_DASHBOARD_TOKEN is required');
  });

  it('accepts Bearer or a login cookie, but requires the cookie for SSE', async () => {
    app = await start();
    expect((await app.inject('/state')).statusCode).toBe(401);
    expect((await app.inject({ url: '/state', headers })).json().status.connected).toBe(false);
    expect((await app.inject({ url: '/events', headers })).statusCode).toBe(401);
    const bad = await app.inject({ method: 'POST', url: '/login', payload: { token: randomUUID() } });
    expect(bad.statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/login', payload: { token } });
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toMatch(/^bh_session=[0-9a-f]{64}; Path=\/api; HttpOnly; SameSite=Strict$/);
    expect(cookie).not.toContain(token);
    expect((await app.inject({ url: '/state', headers: { cookie: cookie.split(';')[0] } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/state', headers: { cookie: `bh_session=${token}` } })).statusCode).toBe(401);
  });

  it('limits login attempts per IP, even for bad tokens', async () => {
    app = await start();
    const login = (remoteAddress: string) => app!.inject({ method: 'POST', url: '/login', remoteAddress, payload: { token: 'bad' } });
    for (let i = 0; i < 5; i++) expect((await login('127.0.0.2')).statusCode).toBe(401);
    expect((await login('127.0.0.2')).statusCode).toBe(429);
    expect((await login('127.0.0.3')).statusCode).toBe(401);
  });

  it('rejects invalid destinations and messages before publishing', async () => {
    app = await start();
    const send = (to: string, message: unknown) => app!.inject({ method: 'POST', url: '/send', headers, payload: { to, message } });
    for (const [to, message] of [['room:*', 'hello'], ['agent:a.b', 'hello'], ['agent:pi-1:extra', 'hello'], ['pi-1', 'hello'], ['agent:pi-1', ' '], ['agent:pi-1', 42]] as const) {
      expect((await send(to, message)).statusCode).toBe(400);
    }
    expect((await send('agent:pi-1', 'hello')).statusCode).toBe(503);
  });
});

it('reloads recent JSONL history and filters by agent', async () => {
  const history = await openHistory(directory);
  const agent = { agentId: 'pi-1', displayName: 'Pi', project: 'bridge-harness' };
  const joined = history.append('join', agent);
  const renamed = history.append('rename', { ...agent, displayName: 'review' }, 'review');
  history.append('join', { ...agent, agentId: 'pi-2' });
  await appendFile(join(directory, 'history.jsonl'), `${JSON.stringify({ ...joined, timestamp: 0 })}\n{partial`);
  app = await start();
  expect((await app.inject({ url: '/history?agentId=pi-1', headers })).json()).toEqual({ events: [joined, renamed] });
});
