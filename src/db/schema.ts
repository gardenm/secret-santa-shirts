import {
  boolean,
  check,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { relations, sql } from "drizzle-orm";
import type { AdapterAccountType } from "next-auth/adapters";

// ---------------------------------------------------------------------------
// Auth.js adapter tables
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  email: text("email").notNull().unique(),
  emailVerified: timestamp("email_verified", { withTimezone: true }),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable(
  "accounts",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").$type<AdapterAccountType>().notNull(),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    refresh_token: text("refresh_token"),
    access_token: text("access_token"),
    expires_at: integer("expires_at"),
    token_type: text("token_type"),
    scope: text("scope"),
    id_token: text("id_token"),
    session_state: text("session_state"),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expires: timestamp("expires", { withTimezone: true }).notNull(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: timestamp("expires", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

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
  /** Per-participant cap on AI generations, bounding spend. */
  generationCap: integer("generation_cap").notNull().default(30),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const participants = pgTable(
  "participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
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

export const generations = pgTable("generations", {
  id: uuid("id").primaryKey().defaultRandom(),
  participantId: uuid("participant_id")
    .notNull()
    .references(() => participants.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
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
