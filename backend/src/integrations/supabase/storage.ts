import { supabaseAdminClient } from './client';
import { STORAGE_BUCKET_CONFIG, type StorageBucket } from './storage.constants';
import type {
  PublicUrlResult,
  SignedUrlOptions,
  SignedUrlResult,
  UploadResult,
} from './storage.types';
import { ServiceUnavailableError, ValidationError } from '../../shared/errors/app-error';

const SUPABASE_CALL_TIMEOUT_MS = 5000;
const MAX_RETRY_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 200;
const MAX_RETRY_DELAY_MS = 2000;

// Saaaame shape as ioredis's retryStrategy in redis/client.ts: exponential
// backoff capped at a max delay. See index.ts / the task summary for why
// this is a small hand-rolled helper rather than a library.
function retryDelay(attempt: number): number {
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function withTimeout<T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`Supabase call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    clearTimeout(timeoutHandle!);
  }
}

// Wraps every network-bound Supabase call: bounded retry (3 attempts,
// exponential backoff) around a per-attempt timeout (5000ms). Never lets a
// raw Supabase SDK error escape — the caller only ever sees an AppError.
async function withResilience<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await withTimeout(operation, SUPABASE_CALL_TIMEOUT_MS);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_RETRY_ATTEMPTS - 1) {
        await sleep(retryDelay(attempt));
      }
    }
  }

  throw new ServiceUnavailableError(
    `Supabase storage operation "${operationName}" failed after ${MAX_RETRY_ATTEMPTS} attempts`,
    { cause: lastError },
  );
}

function validateUpload(
  bucket: StorageBucket,
  file: Buffer | NodeJS.ReadableStream,
  contentType: string,
): void {
  const config = STORAGE_BUCKET_CONFIG[bucket];

  if (config.allowedMimeTypes.length > 0 && !config.allowedMimeTypes.includes(contentType)) {
    throw new ValidationError(`Content type "${contentType}" is not allowed for bucket "${bucket}"`, {
      allowedMimeTypes: config.allowedMimeTypes,
    });
  }

  // Streams don't expose a length upfront without buffering them (which
  // would defeat the point of streaming) — for those, size is enforced
  // server-side by the bucket's fileSizeLimit (see createBucket() below),
  // not here.
  if (Buffer.isBuffer(file) && file.length > config.maxFileSizeBytes) {
    throw new ValidationError(`File exceeds the ${config.maxFileSizeBytes}-byte limit for bucket "${bucket}"`, {
      maxFileSizeBytes: config.maxFileSizeBytes,
      actualSizeBytes: file.length,
    });
  }
}

async function upload(
  bucket: StorageBucket,
  path: string,
  file: Buffer | NodeJS.ReadableStream,
  contentType: string,
  upsert = false,
): Promise<UploadResult> {
  validateUpload(bucket, file, contentType);

  await withResilience('upload', async () => {
    const { error } = await supabaseAdminClient.storage.from(bucket).upload(path, file, {
      contentType,
      upsert,
    });
    if (error) {
      throw error;
    }
  });

  return { bucket, path };
}

async function deleteFile(bucket: StorageBucket, path: string): Promise<void> {
  await withResilience('delete', async () => {
    const { error } = await supabaseAdminClient.storage.from(bucket).remove([path]);
    if (error) {
      throw error;
    }
  });
}

async function move(bucket: StorageBucket, fromPath: string, toPath: string): Promise<void> {
  await withResilience('move', async () => {
    const { error } = await supabaseAdminClient.storage.from(bucket).move(fromPath, toPath);
    if (error) {
      throw error;
    }
  });
}

// Not wrapped in withResilience: Supabase's getPublicUrl is a pure,
// synchronous URL-string construction with no network call, so there's
// nothing to time out or retry.
function getPublicUrl(bucket: StorageBucket, path: string): PublicUrlResult {
  const config = STORAGE_BUCKET_CONFIG[bucket];
  if (!config.isPublic) {
    throw new ValidationError(`Bucket "${bucket}" is private — use getSignedUrl() instead`);
  }

  const { data } = supabaseAdminClient.storage.from(bucket).getPublicUrl(path);
  return { url: data.publicUrl };
}

async function getSignedUrl(
  bucket: StorageBucket,
  path: string,
  options: SignedUrlOptions,
): Promise<SignedUrlResult> {
  const config = STORAGE_BUCKET_CONFIG[bucket];
  if (config.isPublic) {
    throw new ValidationError(`Bucket "${bucket}" is public — use getPublicUrl() instead`);
  }

  const signedUrl = await withResilience('getSignedUrl', async () => {
    const { data, error } = await supabaseAdminClient.storage
      .from(bucket)
      .createSignedUrl(path, options.expirySeconds);
    if (error || !data) {
      throw error ?? new Error('Supabase returned no data for createSignedUrl');
    }
    return data.signedUrl;
  });

  return {
    url: signedUrl,
    expiresAt: new Date(Date.now() + options.expirySeconds * 1000),
  };
}

// Admin/bootstrap operation — not called per-request. Passes this bucket's
// size/MIME config through to Supabase so it's enforced server-side too,
// which matters most for streamed uploads (see validateUpload() above).
async function createBucket(bucket: StorageBucket, isPublic: boolean): Promise<void> {
  const config = STORAGE_BUCKET_CONFIG[bucket];

  await withResilience('createBucket', async () => {
    const { error } = await supabaseAdminClient.storage.createBucket(bucket, {
      public: isPublic,
      fileSizeLimit: config.maxFileSizeBytes,
      allowedMimeTypes: config.allowedMimeTypes.length > 0 ? [...config.allowedMimeTypes] : undefined,
    });
    if (error) {
      throw error;
    }
  });
}

// Single-level list + bulk delete. Supabase Storage's list() is not
// recursive, so nested subfolders under pathPrefix are not walked — this
// matches "lists and bulk-deletes" as specified, not a recursive tree walk.
async function removeFolder(bucket: StorageBucket, pathPrefix: string): Promise<void> {
  const entries = await withResilience('removeFolder:list', async () => {
    const { data, error } = await supabaseAdminClient.storage.from(bucket).list(pathPrefix);
    if (error) {
      throw error;
    }
    return data ?? [];
  });

  if (entries.length === 0) {
    return;
  }

  const filePaths = entries.map((entry) => `${pathPrefix}/${entry.name}`);

  await withResilience('removeFolder:delete', async () => {
    const { error } = await supabaseAdminClient.storage.from(bucket).remove(filePaths);
    if (error) {
      throw error;
    }
  });
}

export const storageService = {
  upload,
  delete: deleteFile,
  move,
  getPublicUrl,
  getSignedUrl,
  createBucket,
  removeFolder,
};
