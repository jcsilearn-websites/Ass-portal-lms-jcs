import { sql } from 'drizzle-orm';
import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { db } from '../db/client';
import { checkJudge0Reachable } from '../integrations/judge0/client';
import { ping as pingRedis } from '../redis/client';

interface ReadinessCheck {
  name: string;
  healthy: boolean;
}

async function checkDatabase(): Promise<ReadinessCheck> {
  try {
    await db.execute(sql`select 1`);
    return { name: 'database', healthy: true };
  } catch {
    return { name: 'database', healthy: false };
  }
}

async function checkRedis(): Promise<ReadinessCheck> {
  return { name: 'redis', healthy: await pingRedis() };
}
// tharun
// checkJudge0Reachable() (integrations/judge0/client.ts) is a lightweight
// one-shot check: no retry, no circuit breaker involvement, 2s timeout. A
// readiness probe needs to be fast and cheap, not resilient.
async function checkJudge0(): Promise<ReadinessCheck> {
  return { name: 'judge0', healthy: await checkJudge0Reachable() };
}

export default fp(async function healthPlugin(fastify: FastifyInstance) {
  // Liveness: is the process up and able to handle a request at all? No
  // dependency checks — a slow/dead DB or Redis shouldn't make an
  // orchestrator think this process itself needs restarting.
  fastify.get('/healthz', async () => {
    return { status: 'ok' };
  });

  // Readiness: is this instance actually able to serve real traffic? Checks
  // every hard dependency and reports exactly which one(s) failed.
  fastify.get('/readyz', async (_request, reply) => {
    const results = await Promise.all([checkDatabase(), checkRedis(), checkJudge0()]);
    const failed = results.filter((result) => !result.healthy).map((result) => result.name);

    if (failed.length > 0) {
      reply.status(503);
      return { status: 'unavailable', failed };
    }

    return { status: 'ok' };
  });
});
