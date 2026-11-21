import { create } from './index.ts';

const app = await create();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void app.close().catch(error => {
      app.log.error(error);
      process.exitCode = 1;
    });
  });
}
try {
  await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3001) });
} catch (error) {
  await app.close();
  throw error;
}
