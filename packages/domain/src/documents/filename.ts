// Filename sanitising (M2-01, architecture §8). The result is safe as a path segment and inside a
// quoted `Content-Disposition` filename, and fits the Airwallex file upload limit of 50 characters.
import { FILENAME_MAX_LENGTH } from "./types";

const FALLBACK = "document";
/** A trailing extension worth replacing: starts with a letter, at most five characters. */
const OLD_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,4}$/;

/**
 * Sanitises a client-supplied name: strips path parts, control and bidi/format characters, folds
 * accents to ASCII, keeps `A-Z a-z 0-9 space . _ - ( )`, collapses whitespace and repeats, drops
 * leading and trailing dots and dashes, replaces the extension with `ext` (the one the bytes
 * decided) and truncates to 50 characters, extension included. An empty result becomes `document`.
 */
export function sanitizeFilename(raw: string | null | undefined, ext: string): string {
  const suffix = `.${ext.toLowerCase().replace(/[^a-z0-9]/g, "")}`;
  let name = String(raw ?? "");
  // Path parts: anything up to the last separator, either style.
  name = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
  name = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // combining marks left by NFKD (é → e)
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "") // control, bidi overrides, zero-width
    .replace(/\s+/gu, " ")
    .replace(/[^A-Za-z0-9 ._()-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/\.{2,}/g, ".")
    .trim();
  name = name.replace(OLD_EXTENSION, "");
  const trimEnds = (s: string) => s.replace(/^[\s._-]+/, "").replace(/[\s.-]+$/, "");
  name = trimEnds(name);
  const room = FILENAME_MAX_LENGTH - suffix.length;
  name = trimEnds(name.slice(0, room));
  return `${name || FALLBACK}${suffix}`;
}
