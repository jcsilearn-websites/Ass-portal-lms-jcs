import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import analyticsRoutes from './modules/analytics/analytics.routes';
import assessmentsRoutes from './modules/assessments/assessments.routes';
import attemptsRoutes from './modules/attempts/attempts.routes';
import authRoutes from './modules/auth/auth.routes';
import chatbotRoutes from './modules/chatbot/chatbot.routes';
import notificationsRoutes from './modules/notifications/notifications.routes';
import organizationRoutes from './modules/organization/organization.routes';
import questionBankRoutes from './modules/question-bank/question-bank.routes';
import reportsRoutes from './modules/reports/reports.routes';
import settingsRoutes from './modules/settings/settings.routes';
import studentsRoutes from './modules/students/students.routes';
import trainersRoutes from './modules/trainers/trainers.routes';
import usersRoutes from './modules/users/users.routes';
import authenticatePlugin from './plugins/authenticate.plugin';
import corsHelmetPlugin from './plugins/cors-helmet.plugin';
import errorHandlerPlugin from './plugins/error-handler.plugin';
import healthPlugin from './plugins/health.plugin';
import rateLimitPlugin from './plugins/rate-limit.plugin';
import requestContextPlugin from './plugins/request-context.plugin';

const API_PREFIX = '/api/v1';

// Largest bucket limit across integrations/supabase/storage.constants.ts
// (the `temporary` bucket, 20MB), not the `avatars` bucket's own tighter
// 5MB — this is a transport-level ceiling shared by every multipart route
// in the app. The tighter, bucket-specific limit is still enforced where it
// belongs: storage.ts's validateUpload() (server-side truth) and
// users.controller.ts's upfront MIME/size check for avatars specifically.
const MULTIPART_MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ trustProxy: true });

  // Registration order:
  //
  // 1. cors-helmet — must wrap literally everything, including error
  //    responses, so even a 500 out of error-handler carries CORS/helmet
  //    security headers.
  await app.register(corsHelmetPlugin);

  // 2. request-context — assigns request.id/request.log before anything
  //    else runs, so every later log line (including error-handler's) is
  //    correlated to the same request id.
  await app.register(requestContextPlugin);

  // 3. error-handler — in place before anything that could throw
  //    (authenticate, rate-limit exhaustion, route handlers) is registered.
  await app.register(errorHandlerPlugin);

  // Not in the originally given order — added here because it's required
  // for correctness, not optional. usersRoutes' preHandlers reference
  // `fastify.authenticate` directly at *registration* time
  // (`preHandler: [fastify.authenticate, requirePermission(...)]`), so the
  // decorator must already exist by the time usersRoutes is registered
  // below, or that line throws immediately (fastify.authenticate would be
  // undefined). It has no ordering dependency on rate-limit/cookie/
  // multipart/health, so it's placed right after error-handler — it only
  // needs to precede the module route registrations at the bottom.
  await app.register(authenticatePlugin);

  // 4. rate-limit (global default; per-route overrides like
  //    ASSESSMENT_SUBMIT_RATE_LIMIT_CONFIG are consumed by future route
  //    files, not wired here).
  await app.register(rateLimitPlugin);

  // 5. cookie — auth.controller.ts reads/writes the refresh token cookie
  //    via request.cookies/reply.setCookie.
  await app.register(fastifyCookie);

  // 6. multipart — users.controller.ts's avatar upload handler calls
  //    request.file().
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: MULTIPART_MAX_FILE_SIZE_BYTES,
    },
  });

  // 7. health — deliberately unprefixed (no /api/v1): liveness/readiness
  //    probes are conventionally bare paths for load balancers/orchestrators.
  await app.register(healthPlugin);

  // --- Module routes, all under API_PREFIX ---
  //
  // No prefix convention existed before this: auth.routes.ts and
  // users.routes.ts both register bare paths today (e.g. '/auth/login',
  // '/users'). '/api/v1' is being established here for the first time,
  // applied via Fastify's register-time `prefix` option rather than baked
  // into each route file's path strings — e.g. '/auth/login' becomes
  // '/api/v1/auth/login'. authRoutes/usersRoutes are plain (non-fp-wrapped)
  // functions, which is what lets Fastify's prefix option apply to the
  // routes they register; the fp-wrapped plugins above still propagate
  // their decorators/hooks (fastify.authenticate, the onRequest hook, the
  // error handler) down into this prefixed child context regardless.
  //
  // Of CLAUDE.md's 13 modules, 12 — auth, users, organization, trainers,
  // students, question-bank, assessments, attempts (Part 1 + Part 2:
  // lifecycle, frozen selections, proctoring_events,
  // assessment_retake_requests, and coding-submission grading via
  // modules/coding), settings (feature_flags, module_toggles,
  // system_settings — CRUD only, no enforcement middleware; see
  // settings.service.ts's module comment for why), reports (Part 1: a
  // student's own attempt history/scores, self-scoped, no permission key
  // — see reports.service.ts's module comment), analytics (batch-level
  // performance summary, staff-facing, gated by analytics.view — see
  // analytics.service.ts's module comment for the passing-threshold and
  // college-scoping design), notifications (in-app + email via Resend;
  // self-scoped GET/PATCH, no create endpoint — rows only get created
  // internally by trigger points inside assessments.service.ts and
  // attempts.service.ts; see notifications.service.ts's module comment
  // for the fire-and-forget email design) — currently export a
  // registrable route plugin. `coding` itself still has no routes of its
  // own (its endpoint is registered by attempts.routes.ts — see
  // coding.routes.ts's own comment).
  //
  // organization.routes.ts registers its own top-level paths (/colleges,
  // /departments, /academic-years) rather than nesting under /organization —
  // consistent with how auth/users register bare, module-scoped paths and
  // let this same register-time `prefix` option do the /api/v1 prefixing.
  // trainers.routes.ts (/trainer-profiles), students.routes.ts
  // (/student-profiles), question-bank.routes.ts (/question-categories,
  // /question-topics, /question-tags, /questions, /question-pools), and
  // assessments.routes.ts (/assessments) all follow the same convention.
  await app.register(authRoutes, { prefix: API_PREFIX });
  await app.register(usersRoutes, { prefix: API_PREFIX });
  await app.register(organizationRoutes, { prefix: API_PREFIX });
  await app.register(trainersRoutes, { prefix: API_PREFIX });
  await app.register(studentsRoutes, { prefix: API_PREFIX });
  await app.register(questionBankRoutes, { prefix: API_PREFIX });
  await app.register(assessmentsRoutes, { prefix: API_PREFIX });
  await app.register(attemptsRoutes, { prefix: API_PREFIX });
  await app.register(settingsRoutes, { prefix: API_PREFIX });
  await app.register(reportsRoutes, { prefix: API_PREFIX });
  await app.register(analyticsRoutes, { prefix: API_PREFIX });
  await app.register(notificationsRoutes, { prefix: API_PREFIX });
  // Phase 6a — chatbot function-calling layer. Gated entirely by
  // 'chatbot.query' (super_admin + faculty only, seeded via a --custom
  // migration) — see chatbot.routes.ts.
  await app.register(chatbotRoutes, { prefix: API_PREFIX });

  return app;
}
