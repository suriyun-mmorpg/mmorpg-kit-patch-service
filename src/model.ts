import { createHash } from "node:crypto";

import { parse, stringify, LosslessNumber } from "lossless-json";

export const MAX_PAYLOAD_BYTES = 3 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Entry {
  dataType: string;
  dataId: number;
  data: Record<string, unknown>;
}

export interface Upload {
  id: string;
  databaseId: string;
  schemaVersion: number;
  description: string;
  entries: Entry[];
}

export interface Metadata {
  id: string;
  databaseId: string;
  schemaVersion: number;
  description: string;
  version: number;
  payloadHash: string;
  createdAt: string;
  publishTime: string;
}

export type Release = Metadata & { payloadJson: string; manifestJson?: string };

export function hash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof LosslessNumber);
}

export function slug(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,95}$/.test(value) ||
      /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value)) {
    throw new ApiError(400, `${field} must be a lowercase slug (1-96 letters, digits, underscores or hyphens; no Windows device names).`);
  }
  return value;
}

export function parseJson(text: string): unknown {
  try {
    const sourceText = text.replace(/^\uFEFF/, "");
    // Validate property names before the library constructs ordinary objects.
    // Discard these native-parsed numbers; only the lossless parse is stored.
    JSON.parse(sourceText, (key, value) => {
      if (["__proto__", "prototype", "constructor", "isLosslessNumber"].includes(key)) {
        throw new ApiError(400, "Reserved object property in patch.");
      }
      return value;
    });
    return parse(sourceText, null, (source: string) => {
      const number = Number(source);
      if (Number.isSafeInteger(number) && /^-?\d+$/.test(source)) {
        return number;
      }
      return new LosslessNumber(source);
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Invalid JSON.");
  }
}

function validateValue(value: unknown, depth = 0): void {
  if (depth > 32) {
    throw new ApiError(400, "Patch nesting exceeds 32 levels.");
  }
  if (value instanceof LosslessNumber) {
    if (!Number.isFinite(Number(value.value))) {
      throw new ApiError(400, "Patch contains a number outside the finite double range.");
    }
    return;
  }
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new ApiError(400, "Patch contains a non-finite or unsafe integer value.");
  }
  if (Array.isArray(value)) {
    if (value.length > 20000) {
      throw new ApiError(400, "Patch arrays cannot exceed 20000 entries.");
    }
    for (const child of value) validateValue(child, depth + 1);
  } else if (object(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor", "isLosslessNumber"].includes(key)) {
        throw new ApiError(400, "Reserved object property in patch.");
      }
      validateValue(child, depth + 1);
    }
  }
}

export function rejectLegacyEnvironment(value: Record<string, unknown>): void {
  if (Object.hasOwn(value, "environment")) {
    throw new ApiError(400, "Environment is no longer supported. Use a separate databaseId for each patch stream.");
  }
}

export function validateUpload(value: unknown): Upload {
  if (!object(value)) throw new ApiError(400, "Expected a patch upload object.");
  const id = slug(value.id ?? crypto.randomUUID().replaceAll("-", ""), "id");
  const databaseId = slug(value.databaseId, "databaseId");
  rejectLegacyEnvironment(value);
  if (value.schemaVersion !== 1) throw new ApiError(400, "Only schemaVersion 1 is supported.");
  const description = value.description ?? "";
  if (typeof description !== "string" || description.length > 2000) {
    throw new ApiError(400, "description must be a string up to 2000 characters.");
  }
  if (!Array.isArray(value.entries) || value.entries.length > 20000) {
    throw new ApiError(400, "entries must be an array of at most 20000 records.");
  }
  const keys = new Set<string>();
  for (const entry of value.entries) {
    if (!object(entry) || typeof entry.dataType !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(entry.dataType) ||
        typeof entry.dataId !== "number" || !Number.isInteger(entry.dataId) || entry.dataId < -2147483648 || entry.dataId > 2147483647 || !object(entry.data)) {
      throw new ApiError(400, "Every record needs a dataType, signed Int32 dataId, and data object.");
    }
    const key = `${entry.dataType}:${entry.dataId}`;
    if (keys.has(key)) throw new ApiError(400, `Duplicate record: ${key}`);
    keys.add(key);
    try {
      validateValue(entry.data);
    } catch (error) {
      if (error instanceof ApiError) {
        throw new ApiError(error.status, `${key}: ${error.message}`);
      }
      throw error;
    }
  }
  const entries = value.entries.map(({ dataType, dataId, data }) => ({ dataType, dataId, data })) as Entry[];
  if (Buffer.byteLength(stringifyJson(entries), "utf8") > MAX_PAYLOAD_BYTES) {
    throw new ApiError(413, "Patch payload exceeds Unity's 3 MiB limit.");
  }
  return { id, databaseId, schemaVersion: 1, description, entries };
}

export function stringifyJson(value: unknown): string {
  const result = stringify(value);
  if (result === undefined) throw new ApiError(400, "Value cannot be encoded as JSON.");
  return result;
}
