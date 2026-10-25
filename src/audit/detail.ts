export class UnsafeAuditDetailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeAuditDetailError";
  }
}

const UNSAFE_KEY_TOKENS = new Set([
  "body",
  "message_body",
  "content",
  "card",
  "pan",
  "token",
  "secret",
  "password",
]);

function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function assertSafeKey(key: string, path: string): void {
  if (keyTokens(key).some((token) => UNSAFE_KEY_TOKENS.has(token))) {
    throw new UnsafeAuditDetailError(`audit detail key "${path}" is not safe to retain`);
  }
}

function assertJsonValue(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null) return;

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new UnsafeAuditDetailError(`audit detail value at "${path}" must be finite`);
      }
      return;
    case "object":
      break;
    default:
      throw new UnsafeAuditDetailError(
        `audit detail value at "${path}" is not JSON-serializable (${typeof value})`,
      );
  }

  if (seen.has(value)) {
    throw new UnsafeAuditDetailError(`audit detail contains a circular reference at "${path}"`);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new UnsafeAuditDetailError(
      `audit detail value at "${path}" must be a plain object or array`,
    );
  }

  for (const [key, child] of Object.entries(value)) {
    assertSafeKey(key, `${path}.${key}`);
    assertJsonValue(child, `${path}.${key}`, seen);
  }
}

export function assertSafeDetail(detail: Record<string, unknown>): void {
  assertJsonValue(detail, "detail", new WeakSet());
}
