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

export class LocalDiskStorage implements Storage {
  constructor(private root: string) {}

  private resolve(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new Error("Invalid storage key");
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
