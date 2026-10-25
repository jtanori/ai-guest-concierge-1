import crypto from "node:crypto";

export function stubEmbedding(text: string, dims = 1536): number[] {
  if (!Number.isInteger(dims) || dims < 1) throw new Error("dims must be a positive integer");

  const digest = crypto.createHash("sha256").update(text, "utf8").digest();
  let state = digest.readUInt32LE(0) || 0x9e3779b9;
  const values: number[] = [];

  for (let index = 0; index < dims; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    values.push((state / 0xffffffff) * 2 - 1);
  }

  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return values.map(() => 0);
  return values.map((value) => value / norm);
}
