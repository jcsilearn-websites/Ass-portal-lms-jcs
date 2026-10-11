const MB = 1024 * 1024;

export const STORAGE_BUCKET = {
  AVATARS: 'avatars',
  QUESTION_IMAGES: 'question-images',
  STUDENT_DOCUMENTS: 'student-documents',
  CERTIFICATES: 'certificates',
  CODING_ATTACHMENTS: 'coding-attachments',
  ORG_BRANDING: 'org-branding',
  TEMPORARY: 'temporary',
} as const;

export type StorageBucket = (typeof STORAGE_BUCKET)[keyof typeof STORAGE_BUCKET];

const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

const DOCUMENT_MIME_TYPES = [...IMAGE_MIME_TYPES, 'application/pdf'] as const;

const CODE_ATTACHMENT_MIME_TYPES = [
  'text/plain',
  'text/x-c',
  'text/x-c++',
  'text/x-java-source',
  'text/x-python',
  'application/javascript',
  'application/json',
  'application/zip',
] as const;

export interface StorageBucketConfig {
  isPublic: boolean;
  maxFileSizeBytes: number;
  // Empty array means "no MIME restriction" — see the `temporary` bucket
  // below, which is deliberately unrestricted since it's short-lived staging.
  allowedMimeTypes: readonly string[];
}
// 2MB — the enforced limit for user-facing "image" uploads (avatars,
// question/option images). Single source of truth, reused in three places:
// STORAGE_BUCKET_CONFIG below (so storage.ts's validateUpload() and
// 2MB — the enforced limit for user-facing "image" uploads (avatars,
// question/option images). Single source of truth, reused in three places:
// STORAGE_BUCKET_CONFIG below (so storage.ts's validateUpload() and
// createBucket() both enforce it), the upfront buffer-length check each of
// those two controllers does before calling into their service
// (users.controller.ts's uploadAvatar, question-bank.controller.ts's
// uploadQuestionImage — see their comments for why that check is duplicated
// there instead of relying on validateUpload alone), and
// ImageUploadField.tsx's client-side pre-check on the frontend. Keeping the
// message here too means the frontend pre-check and the backend rejection
// always show the identical wording/number, never two different limits.
export const IMAGE_UPLOAD_MAX_SIZE_BYTES = 2 * MB;
export const IMAGE_UPLOAD_SIZE_ERROR_MESSAGE =
  'Image exceeds the 2MB limit — please upload a smaller file.';

export const STORAGE_BUCKET_CONFIG: Record<StorageBucket, StorageBucketConfig> = {
  [STORAGE_BUCKET.AVATARS]: {
    isPublic: true,
    maxFileSizeBytes: IMAGE_UPLOAD_MAX_SIZE_BYTES,
    allowedMimeTypes: IMAGE_MIME_TYPES,
  },
  [STORAGE_BUCKET.ORG_BRANDING]: {
    isPublic: true,
    maxFileSizeBytes: 5 * MB,
    allowedMimeTypes: IMAGE_MIME_TYPES,
  },
  [STORAGE_BUCKET.QUESTION_IMAGES]: {
    isPublic: true,
    maxFileSizeBytes: IMAGE_UPLOAD_MAX_SIZE_BYTES,
    allowedMimeTypes: IMAGE_MIME_TYPES,
  },
  [STORAGE_BUCKET.STUDENT_DOCUMENTS]: {
    isPublic: false,
    maxFileSizeBytes: 10 * MB,
    allowedMimeTypes: DOCUMENT_MIME_TYPES,
  },
  [STORAGE_BUCKET.CERTIFICATES]: {
    isPublic: false,
    maxFileSizeBytes: 10 * MB,
    allowedMimeTypes: DOCUMENT_MIME_TYPES,
  },
  [STORAGE_BUCKET.CODING_ATTACHMENTS]: {
    isPublic: false,
    maxFileSizeBytes: 2 * MB,
    allowedMimeTypes: CODE_ATTACHMENT_MIME_TYPES,
  },
  [STORAGE_BUCKET.TEMPORARY]: {
    isPublic: false,
    maxFileSizeBytes: 20 * MB,
    allowedMimeTypes: [],
  },
};
