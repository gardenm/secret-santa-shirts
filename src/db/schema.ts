import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Better Auth tables
//
// Shapes and table names come from Better Auth's own model, so its Drizzle
// adapter can read them. Our exported constants stay plural (`users` rather
// than `user`) because the rest of the app and every test already refers to
// them that way; lib/auth.ts maps the two names explicitly when configuring
// the adapter.
//
// Ids are text rather than uuid because that is what Better Auth generates.
// The $defaultFn keeps direct inserts working - tests and seeds create rows
// without going through Better Auth, and would otherwise have to invent ids.
// ---------------------------------------------------------------------------

export const users = pgTable("user", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  /** Better Auth treats name as required; default keeps bare inserts working. */
  name: text("name").notNull().default(""),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("session", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable("account", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per address that has asked for a sign-in link, so the form cannot be
 * used to mail-bomb someone.
 *
 * Ours rather than Better Auth's: its rate limiter only runs inside the HTTP
 * handler, and we call `auth.api.signInMagicLink` directly from a server
 * action, which bypasses it. Kept out of the `verification` table because that
 * one is keyed by token and its `value` shape is Better Auth's private detail -
 * matching on it would break silently the day they change it.
 *
 * One row per address, updated in place: no growth and nothing to clean up.
 */
export const signInAttempts = pgTable("sign_in_attempts", {
  email: text("email").primaryKey(),
  lastSentAt: timestamp("last_sent_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Magic-link tokens live here. Note: `verification`, not `verification_tokens`. */
export const verifications = pgTable("verification", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => randomUUID()),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Garment catalog
//
// Print dimensions live here rather than as constants, because print area
// varies by garment model - a hoodie is not a tee. Every canvas size and every
// preflight threshold is derived from these rows.
// ---------------------------------------------------------------------------

export const garments = pgTable("garments", {
  id: uuid("id").primaryKey().defaultRandom(),
  model: text("model").notNull().unique(), // e.g. "bella-canvas-3001"
  displayName: text("display_name").notNull(),
  /** Print area in pixels at 300 DPI. */
  printWPx: integer("print_w_px").notNull(),
  printHPx: integer("print_h_px").notNull(),
  sizes: text("sizes").array().notNull(),
  fits: text("fits").array().notNull(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const garmentColours = pgTable(
  "garment_colours",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    garmentId: uuid("garment_id")
      .notNull()
      .references(() => garments.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    hex: text("hex").notNull(),
    /**
     * Drives the DTG white-underbase warnings. On a dark garment a partially
     * transparent pixel still gets a solid white underbase dot, so soft edges
     * print as a chalky halo, and near-black art reads grey over the underbase.
     */
    isDark: boolean("is_dark").notNull(),
    /** Sizes this colour is actually stocked in - not every colour exists in every size. */
    availableSizes: text("available_sizes").array().notNull(),
  },
  (t) => [unique("garment_colours_garment_name_uniq").on(t.garmentId, t.name)],
);

// ---------------------------------------------------------------------------
// Event + participants
// ---------------------------------------------------------------------------

export const eventState = pgEnum("event_state", ["setup", "open", "locked", "revealed"]);

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  deadline: timestamp("deadline", { withTimezone: true }).notNull(),
  revealAt: timestamp("reveal_at", { withTimezone: true }).notNull(),
  state: eventState("state").notNull().default("setup"),
  /** Per-participant cap on AI image generations - what a person thinks of as "my images". */
  generationCap: integer("generation_cap").notNull().default(30),
  /**
   * Per-participant cap on the paid *assists*: background removal and hosted
   * upscaling. Separate from generationCap so one generation, which quietly
   * makes up to two assists of its own, does not eat three of somebody's
   * thirty images. Generous by default - it exists to stop someone clicking
   * "remove background" two hundred times, not to ration ordinary use.
   */
  assistCap: integer("assist_cap").notNull().default(120),
  /**
   * The last local day (YYYY-MM-DD) reminders went out, so a re-triggered or
   * retried cron run does not nudge everyone twice. A day key rather than a
   * timestamp because "once per day" means the group's day, not 24 hours.
   */
  lastReminderDay: text("last_reminder_day"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const participants = pgTable(
  "participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    displayName: text("display_name").notNull(),
    garmentId: uuid("garment_id").references(() => garments.id),
    garmentColourId: uuid("garment_colour_id").references(() => garmentColours.id),
    size: text("size"),
    fit: text("fit"),
    /** Free text: "I like dinosaurs, no politics please". */
    notes: text("notes"),
    sizeConfirmedAt: timestamp("size_confirmed_at", { withTimezone: true }),
    /**
     * Set when the draw runs. After this, a garment change would invalidate
     * work their designer has already done, so it requires admin action.
     */
    garmentLockedAt: timestamp("garment_locked_at", { withTimezone: true }),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("participants_event_user_uniq").on(t.eventId, t.userId)],
);

/**
 * The invite list, which is also the access-control list.
 *
 * `participants` requires a `userId`, so there is nowhere to record "invited
 * but hasn't signed in yet" - the state everyone is in before the event
 * starts. Auth rejects any sign-in whose email is not here, which means the
 * invite list needs no separate allowlist and a stranger with the URL cannot
 * join.
 */
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    /** Always stored lowercased; compare against a lowercased input. */
    email: text("email").notNull(),
    invitedAt: timestamp("invited_at", { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => [unique("invites_event_email_uniq").on(t.eventId, t.email)],
);

export const exclusions = pgTable(
  "exclusions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    participantA: uuid("participant_a")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    participantB: uuid("participant_b")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
  },
  (t) => [
    unique("exclusions_pair_uniq").on(t.eventId, t.participantA, t.participantB),
    check("exclusions_distinct", sql`${t.participantA} <> ${t.participantB}`),
  ],
);

// ---------------------------------------------------------------------------
// Assignments
//
// The three constraints below are the whole correctness story for the draw,
// enforced in storage rather than only in application code: nobody draws
// themselves, nobody gives twice, nobody receives twice.
// ---------------------------------------------------------------------------

export const assignments = pgTable(
  "assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    giverId: uuid("giver_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    recipientId: uuid("recipient_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("assignments_event_giver_uniq").on(t.eventId, t.giverId),
    unique("assignments_event_recipient_uniq").on(t.eventId, t.recipientId),
    check("assignments_no_self", sql`${t.giverId} <> ${t.recipientId}`),
  ],
);

// ---------------------------------------------------------------------------
// Designs
// ---------------------------------------------------------------------------

export const designStatus = pgEnum("design_status", ["draft", "submitted"]);

export const designs = pgTable("designs", {
  id: uuid("id").primaryKey().defaultRandom(),
  assignmentId: uuid("assignment_id")
    .notNull()
    .unique()
    .references(() => assignments.id, { onDelete: "cascade" }),
  /** Fabric.js canvas state, kept so designs stay re-editable. */
  canvasJson: jsonb("canvas_json"),
  printFileUrl: text("print_file_url"),
  previewUrl: text("preview_url"),
  status: designStatus("status").notNull().default("draft"),
  preflight: jsonb("preflight"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const generationKind = pgEnum("generation_kind", ["generate", "assist"]);

/**
 * Every call that cost money, whoever made it.
 *
 * Not only image generation, despite the name: background removal and hosted
 * upscaling are billed too, and counting only generations meant the remedy
 * buttons in the editor could be clicked without limit. `kind` keeps the two
 * allowances apart - see events.generationCap and events.assistCap.
 */
export const generations = pgTable("generations", {
  id: uuid("id").primaryKey().defaultRandom(),
  participantId: uuid("participant_id")
    .notNull()
    .references(() => participants.id, { onDelete: "cascade" }),
  kind: generationKind("kind").notNull().default("generate"),
  /** Empty for assists: there is no prompt behind removing a background. */
  prompt: text("prompt").notNull().default(""),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  imageUrl: text("image_url"),
  costCents: integer("cost_cents").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const garmentsRelations = relations(garments, ({ many }) => ({
  colours: many(garmentColours),
}));

export const garmentColoursRelations = relations(garmentColours, ({ one }) => ({
  garment: one(garments, {
    fields: [garmentColours.garmentId],
    references: [garments.id],
  }),
}));

export const participantsRelations = relations(participants, ({ one }) => ({
  user: one(users, { fields: [participants.userId], references: [users.id] }),
  event: one(events, { fields: [participants.eventId], references: [events.id] }),
  garment: one(garments, { fields: [participants.garmentId], references: [garments.id] }),
  colour: one(garmentColours, {
    fields: [participants.garmentColourId],
    references: [garmentColours.id],
  }),
}));

export const assignmentsRelations = relations(assignments, ({ one }) => ({
  giver: one(participants, {
    fields: [assignments.giverId],
    references: [participants.id],
    relationName: "giver",
  }),
  recipient: one(participants, {
    fields: [assignments.recipientId],
    references: [participants.id],
    relationName: "recipient",
  }),
  design: one(designs, {
    fields: [assignments.id],
    references: [designs.assignmentId],
  }),
}));

export const designsRelations = relations(designs, ({ one }) => ({
  assignment: one(assignments, {
    fields: [designs.assignmentId],
    references: [assignments.id],
  }),
}));
