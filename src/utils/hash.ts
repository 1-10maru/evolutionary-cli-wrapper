import { createHash } from "node:crypto";

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function shortHash(value: string): string {
  return hashText(value).slice(0, 16);
}
