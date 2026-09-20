/**
 * Minimal multipart/form-data reader for image reference uploads.
 *
 * Why not a dependency: the backend needs exactly one optional in-memory file
 * field. multer would add disk/stream semantics and configuration surface for
 * that, and busboy would add a parser we would immediately restrict anyway.
 * This reads the boundary, keeps files in memory only, and enforces hard caps
 * before anything is buffered without limit.
 *
 * It is used ONLY when the request is actually multipart. JSON planning
 * requests never reach this code.
 */

/** Hard caps. Exceeding either aborts parsing immediately. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 4;

export interface ParsedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  buffer: Buffer;
}

export interface MultipartResult {
  fields: Record<string, string>;
  files: ParsedFile[];
}

export class MultipartError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "MultipartError";
    this.code = code;
  }
}

/** Extracts the boundary from a content-type header. */
export function boundaryOf(contentType: string): string | null {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const value = (match?.[1] ?? match?.[2] ?? "").trim();
  return value ? value : null;
}

/**
 * Parses a multipart body into text fields and in-memory files.
 *
 * Throws MultipartError with a stable code when a limit is exceeded or the body
 * is malformed, so the caller can return a structured response rather than a
 * crash.
 */
export function parseMultipart(body: Buffer, contentType: string): MultipartResult {
  const boundary = boundaryOf(contentType);
  if (!boundary) {
    throw new MultipartError("INVALID_REFERENCE_URL", "Malformed upload.");
  }

  const delimiter = Buffer.from(`--${boundary}`);
  const fields: Record<string, string> = {};
  const files: ParsedFile[] = [];

  // Split on the delimiter. Each piece after the first is one part.
  const pieces: Buffer[] = [];
  let cursor = 0;
  let index = body.indexOf(delimiter, cursor);

  while (index !== -1) {
    const next = body.indexOf(delimiter, index + delimiter.length);
    if (next === -1) break;
    pieces.push(body.subarray(index + delimiter.length, next));
    index = next;
  }

  let totalBytes = 0;

  for (const piece of pieces) {
    // Part layout: CRLF headers CRLF CRLF body CRLF
    const headerEnd = piece.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const headerText = piece.subarray(0, headerEnd).toString("utf8");
    const content = piece.subarray(headerEnd + 4, piece.length - 2);

    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const filenameMatch = /filename="([^"]*)"/i.exec(headerText);
    const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(headerText);

    const name = nameMatch?.[1] ?? "";
    const filename = filenameMatch?.[1] ?? "";

    if (!filename) {
      fields[name] = content.toString("utf8").slice(0, 8000);
      continue;
    }

    totalBytes += content.length;
    if (content.length > MAX_FILE_BYTES) {
      throw new MultipartError("IMAGE_TOO_LARGE", "Images must be 5MB or smaller.");
    }
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new MultipartError("IMAGE_TOO_LARGE", "Total upload size is too large.");
    }
    if (files.length >= MAX_FILES) {
      throw new MultipartError("TOO_MANY_REFERENCES", "At most 4 images are supported.");
    }

    files.push({
      fieldname: name,
      originalname: filename,
      mimetype: (typeMatch?.[1] ?? "application/octet-stream").trim(),
      buffer: content,
    });
  }

  return { fields, files };
}