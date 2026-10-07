import type { SignOptions } from 'jsonwebtoken';
import { z } from 'zod';

const DURATION_PATTERN = /^\d+(s|m|h|d)$/;

// jsonwebtoken's SignOptions.expiresIn is `ms`'s StringValue | number (a
// template-literal type like '15m' | '7d', not a bare string). `ms` itself
// is only a transitive dependency here (via jsonwebtoken), not hoisted into
// this project's own node_modules under pnpm's strict layout, so it can't be
// imported by name — derive the string-only half of the type structurally
// from jsonwebtoken's own (directly-depended-on) types instead.
type JwtExpiry = Exclude<NonNullable<SignOptions['expiresIn']>, number>;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  CORS_ORIGIN: z.string().min(1, 'CORS_ORIGIN is required'),

  DATABASE_URL: z
    .string()
    .url('DATABASE_URL must be a valid connection string')
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'DATABASE_URL must start with postgres:// or postgresql://',
    ),

  SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY is required'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_EXPIRY: z
    .string()
    .regex(DURATION_PATTERN, 'JWT_ACCESS_EXPIRY must look like "15m", "1h", or "7d"')
    .transform((value): JwtExpiry => value as JwtExpiry),
  JWT_REFRESH_EXPIRY: z
    .string()
    .regex(DURATION_PATTERN, 'JWT_REFRESH_EXPIRY must look like "15m", "1h", or "7d"')
    .transform((value): JwtExpiry => value as JwtExpiry),

  REDIS_URL: z
    .string()
    .url('REDIS_URL must be a valid connection string')
    .refine(
      (value) => value.startsWith('rediss://'),
      'REDIS_URL must start with rediss:// (Upstash requires TLS)',
    ),

  JUDGE0_BASE_URL: z.string().url('JUDGE0_BASE_URL must be a valid URL'),
  // Optional: a self-hosted Judge0 instance may have no auth enabled at all.
  // Empty string (e.g. an unfilled "JUDGE0_API_KEY=" in .env) is treated the
  // same as unset, rather than failing validation on a blank value.
  JUDGE0_API_KEY: z
    .string()
    .optional()
    .transform((value) => (value ? value : undefined)),

  // Optional, same tier as JUDGE0_API_KEY — email is fire-and-forget,
  // best-effort infrastructure (see notifications.service.ts's module
  // comment), not something the app should refuse to boot over. A missing
  // key means integrations/email/client.ts short-circuits every send with
  // a clear, caught-and-logged error instead of attempting a doomed
  // request; it does NOT mean the backend fails to start, unlike
  // DATABASE_URL/SUPABASE_*/JWT_* which the app cannot function without.
  RESEND_API_KEY: z
    .string()
    .optional()
    .transform((value) => (value ? value : undefined)),

  // Confirmed there's no system_settings 'email.from_address' row to read
  // instead (grepped the whole repo — nothing seeds one, and nothing in
  // this codebase currently reads system_settings at runtime at all; see
  // settings.service.ts's own "item 4" comment). Plain hardcoded env
  // default, same as every other env var with a fallback. This placeholder
  // domain is NOT a Resend-verified sending domain — swap it for a real
  // one before any email actually needs to leave the building.
  EMAIL_FROM_ADDRESS: z
    .string()
    .min(1, 'EMAIL_FROM_ADDRESS must not be empty')
    .default('JCS iLearn <notifications@jcsilearn.app>'),

  // --- NVIDIA (Phase 6a — chatbot function-calling layer) ---
  NVIDIA_BASE_URL: z
    .string()
    .url('NVIDIA_BASE_URL must be a valid URL')
    .default('https://integrate.api.nvidia.com/v1'),
  // Optional, same tier as JUDGE0_API_KEY/RESEND_API_KEY — the chatbot is
  // an add-on feature the rest of the app doesn't depend on to function.
  // Unlike JUDGE0_API_KEY (optional because a self-hosted instance MAY
  // have no auth), NVIDIA's hosted API always requires a key — this is
  // "optional to configure" in the RESEND_API_KEY sense (a real feature
  // that gracefully degrades when unconfigured), not "sometimes doesn't
  // need one." A missing key means integrations/nvidia/client.ts
  // short-circuits every call with a clear ServiceUnavailableError instead
  // of a doomed request; it does NOT mean the backend fails to start.
  NVIDIA_API_KEY: z
    .string()
    .optional()
    .transform((value) => (value ? value : undefined)),
  // Overridable rather than inlined in the client — lets the model be
  // swapped (e.g. to a cheaper/faster NIM model) without a code change.
  // meta/llama-3.1-70b-instruct is a well-supported NVIDIA NIM
  // function-calling model as of this phase; not a hardcoded assumption
  // baked into request-building code.
  NVIDIA_MODEL: z.string().min(1).default('meta/llama-3.1-70b-instruct'),

  // Temporary platform-wide kill switch (UI cleanup phase, item 5) — the
  // single easily-reversible flag chatbot.routes.ts checks to reject
  // POST /chatbot/ask with 503 before chatbot.controller.ts or
  // chatbot.service.ts ever run, so no chatbot_query_log row is ever
  // written for a request while this is false. Flip back to true (or
  // unset — defaults to true) to re-enable; no code change needed either
  // way. z.enum(['true','false']), NOT z.coerce.boolean(): that coercion
  // is a well-known Zod trap here — Boolean('false') is true in plain JS,
  // so z.coerce.boolean() would treat CHATBOT_ENABLED=false as enabled.
  CHATBOT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return parsed.data;
}

export const env = Object.freeze(loadEnv());

export type Env = typeof env;
