import { boolean, index, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './identity.schema';

// No schema.sql precedent for this table (unlike every other module) —
// this enum/table shape was proposed fresh and approved before being
// written here, not matched against a pre-existing CREATE TYPE/CREATE
// TABLE. The matching DDL now also lives in drizzle/reference/schema.sql
// (SECTION 13), added there for consistency once approved.

// Onne value per trigger point named in the notifications module brief —
// deliberately narrow (4 values) rather than a generic 'info'/'alert'
// shape, so the type itself documents exactly what can produce a row.
export const notificationTypeEnum = pgEnum('notification_type_enum', [
  'assessment_published',
  'retake_request_approved',
  'retake_request_rejected',
  'attempt_finalized',
]);

// Polymorphic link-back discriminator (related_entity_type) paired with
// related_entity_id — no FK constraint on related_entity_id since it can
// point at three different tables depending on type. Same "can't strongly
// type this" tradeoff attempts.schema.ts's proctoring_events.event_meta
// already accepts (untyped JSONB there; untyped uuid + discriminator
// here). Values match the three tables the trigger points actually write
// against: assessments, assessment_attempts, assessment_retake_requests.
export const notificationEntityTypeEnum = pgEnum('notification_entity_type_enum', [
  'assessment',
  'attempt',
  'retake_request',
]);

// recipientId cascades on user delete — unlike requestedBy/reviewedBy
// elsewhere (set null, preserve the audit row independent of the actor),
// a notification has no meaning independent of its recipient; same
// judgment call as user_roles.userId's cascade, not
// assessment_retake_requests.requestedBy's set-null.
//
// No updated_at: the only mutation post-insert is the read flip, and
// read_at (nullable, set once) already captures "when that happened" —
// same reasoning assessment_retake_requests.reviewedAt uses to avoid a
// separate mutable-audit-timestamp column.
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    relatedEntityType: notificationEntityTypeEnum('related_entity_type').notNull(),
    relatedEntityId: uuid('related_entity_id').notNull(),
    isRead: boolean('is_read').notNull().default(false),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    // Drives GET /notifications: self-scoped, paginated, newest first.
    recipientCreatedIdx: index('idx_notifications_recipient_created').on(
      table.recipientId,
      table.createdAt,
    ),
    // Drives unread-count / unread-filter without a full table scan.
    recipientUnreadIdx: index('idx_notifications_recipient_unread').on(
      table.recipientId,
      table.isRead,
    ),
  }),
);
