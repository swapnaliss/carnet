// File upload to the files host (`AIRWALLEX_FILES_URL`), multipart field `file`. Returns the
// `file_id` used in an RFI ATTACHMENT answer. Carnet only ever sends PDF or JPEG, filename at most 50
// characters; the sandbox enforces neither the documented 20 MB limit nor most types (M0-04 check 3),
// so these checks are ours. Uploads carry no request_id and are not retried automatically.
import { z } from "zod";
import { authed } from "./auth";
import { AirwallexInputError } from "./http";
import { type Ctx, WireInt } from "./wire";

export const MAX_FILENAME_CHARS = 50;

export type UploadContentType = "application/pdf" | "image/jpeg";

export interface UploadFileInput {
  filename: string;
  contentType: UploadContentType;
  bytes: Uint8Array;
}

export interface UploadedFile {
  fileId: string;
  filename: string | null;
  size: number | null;
  createdAt: number | null;
}

export const UploadWire = z
  .looseObject({
    file_id: z.string().min(1),
    filename: z.string().nullish(),
    size: WireInt.nullish(),
    created: WireInt.nullish(),
  })
  .transform(
    (w): UploadedFile => ({
      fileId: w.file_id,
      filename: w.filename ?? null,
      size: w.size ?? null,
      createdAt: w.created ?? null,
    }),
  );

const EXTENSIONS: Record<UploadContentType, RegExp> = {
  "application/pdf": /\.pdf$/i,
  "image/jpeg": /\.jpe?g$/i,
};

function magicMatches(type: UploadContentType, b: Uint8Array): boolean {
  if (type === "application/pdf") {
    return (
      b.length >= 5 &&
      b[0] === 0x25 &&
      b[1] === 0x50 &&
      b[2] === 0x44 &&
      b[3] === 0x46 &&
      b[4] === 0x2d
    );
  }
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

export function checkUpload(input: UploadFileInput): void {
  const name = input.filename;
  if (name.length === 0 || name.length > MAX_FILENAME_CHARS) {
    throw new AirwallexInputError(`filename must be 1 to ${MAX_FILENAME_CHARS} characters`);
  }
  if (/[/\\\0]/.test(name)) throw new AirwallexInputError("filename must not contain a path");
  const ext = EXTENSIONS[input.contentType];
  if (!ext) throw new AirwallexInputError("only PDF or JPEG files are uploaded");
  if (!ext.test(name)) throw new AirwallexInputError("filename extension does not match the type");
  if (!magicMatches(input.contentType, input.bytes)) {
    throw new AirwallexInputError("file bytes are not a PDF or JPEG");
  }
}

export async function uploadFile(ctx: Ctx, input: UploadFileInput): Promise<UploadedFile> {
  checkUpload(input);
  const form = new FormData();
  form.append("file", new Blob([input.bytes], { type: input.contentType }), input.filename);
  return authed(ctx.http, ctx.tokens, {
    method: "POST",
    path: "/api/v1/files/upload",
    host: "files",
    form,
    schema: UploadWire,
    retryable: false,
  });
}
