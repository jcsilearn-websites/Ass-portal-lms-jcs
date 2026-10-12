import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { URL } from 'node:url';
import { env } from '../config/env';
import * as identitySchema from './schema/identity.schema';

const schema = { ...identitySchema };
const dbUrl = new URL(env.DATABASE_URL);
const socketHost = dbUrl.searchParams.get('host');
// max: 6, not postgres.js's higher common defaults — sized against a real
// constraint, not guessed. This Supabase project's pooler runs in SESSION
// mode with a hard, project-wide cap of 15 total connections (confirmed
// live during item 5c's investigation: a single heavy request's own query
// fan-out hit `EMAXCONNSESSION: max clients reached in session mode - max
// clients are limited to pool_size: 15` twice, independent of this app's
// own `max`). 6 leaves real headroom even in the worst realistic case for
// this dev workflow — the backend's `tsx watch` process and a `pnpm test`
// run alive at once in two terminals are two SEPARATE OS processes, each
// opening their own pool up to `max` independently (vitest.config.ts's
// fileParallelism: false keeps the test run itself to one pool, not one
// per file, but that one process is still additional to the dev server's).
// Two such processes at max:6 is 12 of 15, leaving 3 free for a psql
// session or Supabase Studio — at the previous max:10, the same two-process
// case was already at the 15-connection ceiling with zero margin.
//
// A structurally better fix — switching this project's pooler connection
// to TRANSACTION mode (Supavisor, typically port 6543) — was deliberately
// NOT done here. That needs `prepare: false` on this client plus real
// ting of anything relying on session-level Postgres features, and is
// queued as its own follow-up phase, not bundled into this pool-size
// mitigation.
const queryClient = socketHost?.startsWith('/')
  ? postgres({
      host: socketHost,
      database: dbUrl.pathname.slice(1),
      username: decodeURIComponent(dbUrl.username),
      password: decodeURIComponent(dbUrl.password),
      max: 6,
    })
  : postgres(env.DATABASE_URL, { max: 6 });

const realDb = drizzle(queryClient, { schema });

export type Database = typeof realDb;

// --- Test-only ambient transaction context ------------------------------
//
// Lets every `db.select()`/`db.insert()`/`db.transaction()`/etc. call
// anywhere in src/modules/* transparently resolve to a test-owned,
// always-rolled-back transaction instead of the real pool — with ZERO
// changes to any repository/service call site. This exists to close a real
// gap: integration tests run against this same live dev database (see
// tests/integration/helpers.ts's own comments), and the previous explicit
// insert-then-cleanup pattern (FixtureRegistry/cleanupRegistry) cannot
// survive a hard-killed test process — nothing runs to clean up if the
// Node process itself dies mid-fixture-build. A transaction that's simply
// never committed sidesteps that: if the connection holding it disconnects
// for ANY reason (graceful rollback call, thrown error, or the whole
// process being killed), Postgres itself discards every uncommitted write
// on that session — there's nothing for any cleanup code to do, because
// nothing was ever durably written. See
// tests/integration/helpers.ts/beginAmbientTestTransaction's own comment
// for the mechanics of opening one of these across a whole test file's
// beforeAll -> it -> afterAll lifecycle.
//
// SESSION-MODE POOLING DEPENDENCY — re-validate before ever changing this:
// the "killed process -> connection drops -> transaction rolls back"
// guarantee assumes the physical connection this transaction runs on maps
// 1:1 to one stable Postgres backend session for its whole lifetime, which
// is exactly what THIS project's Supavisor pooler currently provides
// (SESSION mode — see the `max: 6` comment below). Supabase transaction-mode
// pooling (Supavisor/PgBouncer transaction pooling) is a real, explicitly
// considered future migration for this project (see that same comment) —
// under transaction-mode pooling, a client's "connection" is only mapped to
// a real backend connection for the duration of ONE transaction, and long-
// -lived transactions spanning an entire test file's lifecycle (tens of
// seconds, up to vitest.config.ts's 60s hookTimeout) are exactly the kind
// of session-level usage transaction-mode poolers are known to handle
// poorly (the pooler may reclaim the connection independently of the
// client, or such long transactions may starve the small backend
// connection count behind the pooler). If this project ever migrates to
// transaction-mode pooling, this entire mechanism needs re-validation, not
// just a config tweak.
//
// GATING — how this is guaranteed inert for the real app/dev-server path:
// ambientTransactionsEnabled can ONLY become true via
// enableAmbientTestTransactions() below, and that function refuses to run
// unless env.NODE_ENV === 'test'. Nothing under src/ ever calls
// enableAmbientTestTransactions() — its only caller anywhere in this repo
// is tests/setup.ts, vitest's own setupFiles hook, which is never part of
// the `pnpm dev`/`pnpm start`/server.ts path. vitest sets
// process.env.NODE_ENV = 'test' automatically for every run (its own
// documented behavior — nothing in this project's scripts sets it
// manually), so this doesn't depend on any test script remembering to set
// an env var either. Net effect for the app/dev-server path:
// ambientTransactionsEnabled is always false there, resolveActiveDb()
// below always short-circuits to realDb on its very first check, and the
// Proxy two functions down is a zero-cost passthrough to the exact same
// object `db` always pointed at before this change existed.
const ambientTestTransaction = new AsyncLocalStorage<Database>();
let ambientTransactionsEnabled = false;

export function enableAmbientTestTransactions(): void {
  if (env.NODE_ENV !== 'test') {
    throw new Error(
      'enableAmbientTestTransactions() called with NODE_ENV !== "test" — refusing to ' +
        'enable ambient test-transaction routing outside a real test run.',
    );
  }
  ambientTransactionsEnabled = true;
}

function resolveActiveDb(): Database {
  if (!ambientTransactionsEnabled || env.NODE_ENV !== 'test') return realDb;
  return ambientTestTransaction.getStore() ?? realDb;
}

// Transparent delegating Proxy, not a second Database implementation — every
// property access re-resolves resolveActiveDb() and forwards to whichever
// object is actually active right now. Functions are returned pre-bound to
// the RESOLVED object (not the Proxy) via .bind(active), not as bare
// references: drizzle-orm's classes use JS private (#) fields internally,
// and `db.select(...)`'s call syntax would otherwise invoke the returned
// function with `this` set to the Proxy itself (per normal JS method-call
// semantics), which throws `TypeError: Cannot read private member from an
// object whose class did not declare it` the instant that method touches a
// #field. .bind(active) fixes `this` to the real object before the caller
// ever receives the function, sidestepping that regardless of call syntax.
// Only the OUTERMOST call (db.select, db.insert, db.transaction, ...) goes
// through this Proxy at all — everything chained after it (.from(...),
// .where(...), etc.) runs on drizzle's own builder objects directly,
// completely untouched by this file, exactly as before this change.
export const db: Database = new Proxy(realDb, {
  get(_target, prop, _receiver) {
    const active = resolveActiveDb();
    const value = Reflect.get(active as object, prop, active);
    return typeof value === 'function' ? value.bind(active) : value;
  },
});

export interface AmbientTestTransaction {
  rollback(): Promise<void>;
}

// Opens ONE reserved physical connection (postgres.js's queryClient.reserve()
// — pins a single connection out of the pool for this call's exclusive use,
// as opposed to db.transaction()'s callback-scoped variant, which can't
// span multiple, separately-invoked vitest hooks — a test file's beforeAll,
// it, and afterAll are independent calls from vitest's own runner, not
// nested continuations of one async function, so there is no single
// callback this could be handed to), issues a real BEGIN on it, and makes
// every ambient `db` call resolve to THIS transaction — for every hook in
// the current test file — until rollback() is called. Test-only: throws if
// enableAmbientTestTransactions() hasn't run first (see that function).
export async function beginAmbientTestTransaction(): Promise<AmbientTestTransaction> {
  if (!ambientTransactionsEnabled) {
    throw new Error(
      'beginAmbientTestTransaction() called before enableAmbientTestTransactions() — ' +
        'refusing to open a test transaction against a routing path that is not active.',
    );
  }

  const reserved = await queryClient.reserve();
  // postgres.js's reserve() returns a bare Sql instance built via its
  // internal Sql(handler) factory directly — unlike the top-level client
  // (which the outer Postgres() factory further Object.assigns `.options`
  // onto after construction), the reserved instance never gets `.options`
  // attached at all. drizzle-orm's postgres-js construct() unconditionally
  // writes `client.options.parsers[type]`/`.serializers[type]` during setup
  // (disabling its own date/time/interval type coercion so drizzle can
  // parse those itself) and throws on `reserved.options` being undefined
  // without this. Confirmed against drizzle-orm's own drizzle.mock() helper
  // (postgres-js/driver.js), which shims this exact same
  // `{ options: { parsers: {}, serializers: {} } }` shape for its own
  // client-less mock construction — not a guess, the same fix drizzle
  // itself uses. Fresh objects per call, not shared with queryClient.options
  // — construct() mutates these in place, and each reserved connection gets
  // its own independent copy rather than touching the real client's.
  //
  // Separately, several repository functions (question-bank, assessments,
  // attempts, organization, students) call db.transaction(async (tx) => ...)
  // for their own atomic multi-insert operations. drizzle-orm's
  // PostgresJsSession.transaction() (session.js) unconditionally calls
  // `this.client.begin(...)` — and postgres.js's reserve() doesn't attach
  // `.begin` to the reserved instance either (same gap as `.options` above:
  // only the top-level client gets it via Object.assign in Postgres()'s
  // outer factory). Without a shim, every one of those repository calls
  // throws `this.client.begin is not a function` the moment `db` ambiently
  // resolves to this reserved connection.
  //
  // A literal `BEGIN`/`COMMIT` shim would be actively wrong here, not just
  // missing: reserved is already inside the real transaction opened by the
  // `BEGIN` just below. Postgres has no true nested transactions — running
  // a second bare BEGIN on an already-open transaction is a silent no-op
  // (with a WARNING), and critically, the matching COMMIT at the end of a
  // naive shim would COMMIT THE WHOLE OUTER TEST TRANSACTION the instant
  // any repository function's internal db.transaction() call finished —
  // defeating the entire point of this mechanism. SAVEPOINT is the correct
  // primitive for "nested transaction while already inside a transaction"
  // — this is exactly what drizzle's own PostgresJsTransaction.transaction()
  // (the ALREADY-nested case, i.e. tx.transaction() called from inside an
  // existing tx) does via `.session.client.savepoint(...)` one level down in
  // this same session.js — this shim reproduces that same contract for the
  // top-level `.begin()` entry point instead, since `txDb` below is
  // constructed as a plain PostgresJsDatabase (via drizzle()), not a
  // PostgresJsTransaction, so repository code's `db.transaction()` always
  // goes through `.begin()`, never `.savepoint()`, regardless of the fact
  // that at the raw SQL level we're already inside a transaction.
  let savepointCounter = 0;
  Object.assign(reserved, {
    options: { parsers: {}, serializers: {} },
    async begin(
      optionsOrCallback: unknown,
      maybeCallback?: (sql: typeof reserved) => Promise<unknown>,
    ) {
      const callback = (
        typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
      ) as (sql: typeof reserved) => Promise<unknown>;
      const savepointName = `ambient_test_tx_sp_${++savepointCounter}`;
      await reserved.unsafe(`SAVEPOINT ${savepointName}`);
      try {
        const result = await callback(reserved);
        await reserved.unsafe(`RELEASE SAVEPOINT ${savepointName}`);
        return result;
      } catch (error) {
        await reserved.unsafe(`ROLLBACK TO SAVEPOINT ${savepointName}`);
        throw error;
      }
    },
  });
  await reserved`BEGIN`;
  const txDb = drizzle(reserved, { schema }) as Database;
  ambientTestTransaction.enterWith(txDb);

  let rolledBack = false;
  return {
    async rollback() {
      if (rolledBack) return;
      rolledBack = true;
      try {
        await reserved`ROLLBACK`;
      } finally {
        reserved.release();
        // Disables the ALS instance until the next enterWith()/run() call —
        // without this, whatever runs next in this same worker process
        // (another describe block in this file, or the next test file, if
        // it doesn't itself open a fresh ambient transaction) would keep
        // resolving `db` to this now-rolled-back-and-released connection.
        ambientTestTransaction.disable();
      }
    },
  };
}

// For server.ts's graceful shutdown (CLAUDE.md non-negotiable #5: drain and
// close the DB pool before exit). drizzle's `db` object doesn't itself
// expose a close/end method — only the underlying postgres.js client does —
// so this is exported the same way redis/client.ts exports disconnectRedis().
export async function closeDatabase(): Promise<void> {
  await queryClient.end();
}
