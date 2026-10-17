import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { env } from "../env";

export interface Storage {
  /** Stores bytes under `${folder}/${random}.${ext}` and returns the key. */
  save(folder: string, ext: string, data: Buffer): Promise<string>;
  read(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

/** Only keys we generate ourselves are valid; this also blocks path traversal. */
export const KEY_PATTERN = /^[a-z0-9-]+\/[a-f0-9]{32}\.(png|jpg|webp)$/;

/** Association documents live in the "documents" folder and are NEVER served from /uploads: only /api/documents/<id>, which checks who may see them. */
export const DOC_KEY_PATTERN = /^documents\/[a-f0-9]{32}\.(pdf|docx|doc|xlsx|xls|pptx|ppt|odt|ods|odp)$/;

export class LocalDiskStorage implements Storage {
  constructor(private root: string) {}

  private resolve(key: string): string {
    if (!KEY_PATTERN.test(key) && !DOC_KEY_PATTERN.test(key)) throw new Error("Invalid storage key");
    return path.join(this.root, key);
  }

  async save(folder: string, ext: string, data: Buffer): Promise<string> {
    const key = `${folder}/${randomBytes(16).toString("hex")}.${ext}`;
    const file = this.resolve(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
    return key;
  }

  async read(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolve(key)).catch(() => {});
  }
}

let storage: Storage | undefined;
export function getStorage(): Storage {
  return (storage ??= new LocalDiskStorage(path.resolve(env().UPLOAD_DIR)));
}
export function setStorage(s: Storage | undefined) {
  storage = s;
}

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** Detects the image type from magic bytes (never trust the client's filename or MIME type). */
export function sniffImage(data: Buffer): { ext: "png" | "jpg" | "webp"; contentType: string } | null {
  if (data.length > 12 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: "png", contentType: "image/png" };
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { ext: "jpg", contentType: "image/jpeg" };
  if (data.length > 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return { ext: "webp", contentType: "image/webp" };
  return null;
}

export const CONTENT_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

export const DOCUMENT_CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

const ZIP_DOCS = new Set(["docx", "xlsx", "pptx", "odt", "ods", "odp"]);
const OLE_DOCS = new Set(["doc", "xls", "ppt"]);

/**
 * Accepts PDF and common office formats. The type is decided from the file's magic bytes (a PDF must really be one);
 * for the zip- and OLE-based office formats the bytes only prove the container, so the extension picks the format
 * within it. Files are always downloaded as attachments with a fixed content type, never rendered by the browser.
 */
export function sniffDocument(data: Buffer, fileName: string): { ext: keyof typeof DOCUMENT_CONTENT_TYPES; contentType: string } | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (data.length > 5 && data.subarray(0, 5).toString("ascii") === "%PDF-") return { ext: "pdf", contentType: DOCUMENT_CONTENT_TYPES.pdf! };
  if (data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04 && ZIP_DOCS.has(ext)) return { ext, contentType: DOCUMENT_CONTENT_TYPES[ext]! };
  if (data.length > 8 && data.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) && OLE_DOCS.has(ext)) return { ext, contentType: DOCUMENT_CONTENT_TYPES[ext]! };
  return null;
}
