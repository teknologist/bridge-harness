import { createHmac, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import fastify from 'fastify';
import { buildAgentCommand } from '../../../../../dist/spawn/command.js';
import { rexBin, spawnAgentTab } from '../../../../../dist/spawn/spawn.js';
import { execFileSync } from 'node:child_process';
import type { HistoryResponse, HostsResponse, MessagesResponse, SelfRequest, SendRequest, ServerEvent, SpawnRequest, SpawnResponse, TranscriptResponse } from '../../../shared/contract.ts';
import { createFleet, subjectToken } from './fleet.ts';
import { openHistory } from './history.ts';
import { openMessageStore } from './messages.ts';

const SESSION = 'bh_session';
const cookieAttributes = 'Path=/api; HttpOnly; SameSite=Strict';
const compare = (actual: string, expected: Buffer) => {
  const bytes = Buffer.from(actual);
  return bytes.length === expected.length && timingSafeEqual(bytes, expected);
};
const string = (maxLength: number, minLength = 1, pattern?: string) => ({ type: 'string', maxLength, minLength, pattern });
const object = (properties: object, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const body = (properties: object, required: string[] = []) => ({ schema: { body: object(properties, required) } });

export async function create(options: { dial?: Parameters<typeof createFleet>[4]; dataDirectory?: string } = {}) {
  const token = process.env.BRIDGE_DASHBOARD_TOKEN;
  if (!token) throw new Error('BRIDGE_DASHBOARD_TOKEN is required');
  const expected = Buffer.from(token);
  const session = createHmac('sha256', expected).update('bridge-dashboard-session').digest('hex');
  const expectedSession = Buffer.from(session);
  const app = fastify({ logger: true, ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  const dataDirectory = options.dataDirectory ?? process.env.BRIDGE_DASHBOARD_DATA ?? join(homedir(), '.bridge-harness');
  const history = await openHistory(dataDirectory);
  const retentionDays = Number(process.env.BRIDGE_DASHBOARD_RETENTION_DAYS) || 30;
  // Pi agents launch through this command (space-separated argv, prompt appended).
  const piLauncher = (process.env.BRIDGE_DASHBOARD_PI_CMD?.trim() || 'pi-profile nats').split(/\s+/);
  const store = openMessageStore(dataDirectory, retentionDays);
  const clients = new Set<(event?: ServerEvent) => void>();
  const fleet = createFleet(history, store, event => { for (const client of clients) client(event); }, message => app.log.warn(message), options.dial);
  const attempts = new Map<string, { count: number; until: number }>();
  const cleanup = setInterval(() => {
    for (const [ip, attempt] of attempts) if (attempt.until <= Date.now()) attempts.delete(ip);
  }, 60_000);
  app.addHook('preClose', async () => { for (const client of clients) client(); });
  app.addHook('onClose', async () => { clearInterval(cleanup); await fleet.close(); });
  app.setErrorHandler((error, _request, reply) => {
    const { statusCode = 500, message } = error as { statusCode?: number; message?: string };
    if (statusCode >= 500) app.log.error(error);
    return reply.code(statusCode).send({ error: statusCode < 500 ? message : 'Internal server error' });
  });

  app.addHook('onRequest', async (request, reply) => {
    const { url } = request.routeOptions;
    const bearer = request.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    const cookie = request.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${SESSION}=`))?.slice(SESSION.length + 1);
    const bearerOk = url !== '/events' && bearer !== undefined && compare(bearer, expected);
    if (request.method === 'POST' && !bearerOk && ['same-site', 'cross-site'].includes(String(request.headers['sec-fetch-site']))) {
      return reply.code(403).send({ error: 'Cross-origin requests are not allowed' });
    }
    if (url !== '/login' && !bearerOk && !(cookie !== undefined && compare(cookie, expectedSession))) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
    if (url === '/login') {
      const now = Date.now();
      let attempt = attempts.get(request.ip);
      if (!attempt || attempt.until <= now) {
        attempt = { count: 0, until: now + 60_000 };
        attempts.set(request.ip, attempt);
      }
      if (++attempt.count > 5) return reply.header('Retry-After', Math.ceil((attempt.until - now) / 1_000)).code(429).send({ error: 'Too many login attempts' });
    }
  });

  app.post<{ Body: { token: string } }>('/login', body({ token: string(4_096) }, ['token']), async (request, reply) => {
    if (!compare(request.body.token, expected)) return reply.code(401).send({ error: 'Invalid token' });
    return reply.header('Set-Cookie', `${SESSION}=${session}; ${cookieAttributes}`).send({ ok: true });
  });
  app.post('/logout', async (_request, reply) => reply.header('Set-Cookie', `${SESSION}=; ${cookieAttributes}; Max-Age=0`).send({ ok: true }));
  app.get('/state', async () => fleet.state());
  app.get<{ Querystring: { key: string; before?: string; limit?: string } }>('/threads/messages', {
    schema: { querystring: object({ key: string(520), before: string(32, 1, '^[0-9]+$'), limit: string(3, 1, '^[0-9]+$') }, ['key']) },
  }, async ({ query }): Promise<MessagesResponse> => fleet.messages(query.key, query.before, Math.max(1, Math.min(200, Number(query.limit ?? 200)))));
  app.get<{ Querystring: { agentId: string; before?: string; limit?: string } }>('/transcript', {
    schema: { querystring: object({ agentId: string(200), before: string(16, 1, '^[0-9]+$'), limit: string(3, 1, '^[0-9]+$') }, ['agentId']) },
  }, async ({ query }): Promise<TranscriptResponse> => fleet.transcript(query.agentId, query.before === undefined ? undefined : Number(query.before), Math.max(1, Math.min(500, Number(query.limit ?? 200)))));
  app.post<{ Body: { key: string } }>('/threads/read', body({ key: string(520) }, ['key']), async ({ body }) => {
    fleet.read(body.key);
    return { ok: true };
  });
  app.get<{ Querystring: { since?: string; agentId?: string; limit?: string } }>('/history', {
    schema: { querystring: object({ since: string(16, 1, '^[0-9]+$'), agentId: string(255), limit: string(4, 1, '^[0-9]+$') }) },
  }, async ({ query }): Promise<HistoryResponse> => ({ events: history.list(Number(query.since ?? 0), query.agentId, Math.max(1, Math.min(1_000, Number(query.limit ?? 1_000)))) }));
  app.post<{ Body: SendRequest }>('/send', body({
    to: string(261, 1, `^(agent|room):${subjectToken.slice(1)}`), message: string(64_000, 1, '\\S'),
  }, ['to', 'message']), async (request, reply) => {
    const result = fleet.send(request.body.to, request.body.message);
    return result ?? reply.code(503).send({ error: 'NATS is not connected' });
  });
  app.post<{ Body: SelfRequest }>('/self', body({ name: string(255, 1, subjectToken), status: string(40, 0, '^[^\\r\\n]*$') }), async ({ body }) => {
    fleet.updateSelf(body.name, body.status?.trim());
    return { ok: true, self: fleet.self };
  });
  app.post<{ Body: { project: string } }>('/project', body({ project: string(255, 1, subjectToken) }, ['project']), async ({ body }) => {
    fleet.switchProject(body.project);
    return { ok: true, project: fleet.self.project };
  });
  // Rex hosts (`rex hosts`), the remote spawn targets. Empty when rex is absent.
  const rexHosts = (): string[] => {
    try {
      const out = execFileSync(rexBin(process.env), ['hosts', '--json'], { encoding: 'utf8', timeout: 5_000 });
      return (JSON.parse(out).hosts ?? []).map((h: { host?: { label?: string } }) => h.host?.label).filter(Boolean);
    } catch { return []; }
  };
  app.get('/hosts', async (): Promise<HostsResponse> => ({ hosts: rexHosts() }));
  app.post<{ Body: SpawnRequest }>('/spawn', body({
    tool: { enum: ['pi', 'claude'] }, name: string(64, 1, '^[a-zA-Z0-9_-]+$'), task: string(4_096, 1, '^[^#\\p{Cc}\\p{Zl}\\p{Zp}]+$'),
    cwd: string(1_024, 0, '^[^\\p{Cc}]*$'), host: string(255, 0, '^[^\\p{Cc}]*$'),
  }, ['tool', 'name', 'task']), async ({ body }, reply) => {
    if (body.host && !rexHosts().includes(body.host)) return reply.code(400).send({ error: `unknown rex host: ${body.host}` });
    const launcher = body.tool === 'pi' ? piLauncher : undefined;
    const res: SpawnResponse = spawnAgentTab(buildAgentCommand({ ...body, requester: fleet.self.agentId, launcher }));
    return { spawned: res.spawned, detail: res.detail, manualCommand: res.manualCommand };
  });
  app.get('/events', (_request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no', Connection: 'keep-alive',
    });
    const write = (frame: string) => { if (!response.write(frame)) response.destroy(); };
    const client = (event?: ServerEvent) => {
      if (!event) { response.end(); return; }
      write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    const ping = setInterval(() => write(': ping\n\n'), 15_000);
    response.once('close', () => { clearInterval(ping); clients.delete(client); });
    clients.add(client);
    write(': connected\n\n');
  });
  return app;
}
