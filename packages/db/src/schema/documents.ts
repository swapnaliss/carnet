import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt, oneOf } from "./columns";

// Mirror DOCUMENT_KINDS and DOCUMENT_MIMES in @carnet/domain (a unit test keeps them equal). The
// schema does not import the domain so drizzle-kit can load it on its own.
export const DOCUMENT_KIND_VALUES = [
  "invoice",
  "contract",
  "purchase_order",
  "statement",
  "other",
] as const;
export const DOCUMENT_MIME_VALUES = ["application/pdf", "image/jpeg", "image/png"] as const;

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
});

// ADR 0003: bytes in Postgres with their SHA-256, immutable. The CHECK recomputes the hash and the
// size from the bytes, so a row can never carry a hash of other bytes. The app role may update only
// `kind` and `filename`, and a trigger refuses any change to bytes, sha256, size, mime or business
// for every role (migration 0005). Identical bytes in one business are one row.
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    bytes: bytea("bytes").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("documents_business_id_created_at_idx").on(t.businessId, t.createdAt),
    uniqueIndex("documents_business_id_sha256_key").on(t.businessId, t.sha256),
    unique("documents_id_business_id_key").on(t.id, t.businessId),
    check("documents_kind_check", oneOf("kind", DOCUMENT_KIND_VALUES)),
    check("documents_mime_check", oneOf("mime", DOCUMENT_MIME_VALUES)),
    check("documents_filename_check", sql`char_length(${t.filename}) BETWEEN 1 AND 50`),
    check("documents_size_check", sql`${t.size} > 0 AND ${t.size} = octet_length(${t.bytes})`),
    check("documents_sha256_check", sql`${t.sha256} = encode(sha256(${t.bytes}), 'hex')`),
  ],
);
