/**
 * Neon Object Storage wiring (D13's storage layer).
 *
 * S3-compatible, path-style, SigV4 — the official AWS SDK works per the
 * Neon skill. Bucket `assets` is declared in neon.ts (private bucket:
 * every request needs the branch credential; presigned URLs come later
 * with real upload flows). The endpoint + credentials are branch-scoped,
 * so a Neon branch carries its own storage state with the database.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

/** Declared in neon.ts (`buckets: { assets: { access: "private" } }`). */
export const NEON_BUCKET_ASSETS = "assets";
/** Prefix for W00 smoke objects — they are cleaned up after the check. */
export const NEON_SMOKE_PREFIX = "neon-smoke/";

export interface StorageEnv {
  endpointUrl: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class StorageEnvError extends Error {}

export function storageEnv(
  source: Record<string, string | undefined> = process.env,
): StorageEnv {
  const endpointUrl = source["AWS_ENDPOINT_URL_S3"];
  const region = source["AWS_REGION"];
  const accessKeyId = source["AWS_ACCESS_KEY_ID"];
  const secretAccessKey = source["AWS_SECRET_ACCESS_KEY"];
  for (const [name, value] of Object.entries({
    AWS_ENDPOINT_URL_S3: endpointUrl,
    AWS_REGION: region,
    AWS_ACCESS_KEY_ID: accessKeyId,
    AWS_SECRET_ACCESS_KEY: secretAccessKey,
  })) {
    if (!value) throw new StorageEnvError(`missing ${name}`);
  }
  return {
    endpointUrl: endpointUrl as string,
    region: region as string,
    accessKeyId: accessKeyId as string,
    secretAccessKey: secretAccessKey as string,
  };
}

export function getS3Client(env: StorageEnv = storageEnv()): S3Client {
  return new S3Client({
    region: env.region,
    endpoint: env.endpointUrl,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.accessKeyId,
      secretAccessKey: env.secretAccessKey,
    },
  });
}

export async function putObject(
  client: S3Client,
  bucket: string,
  key: string,
  body: string,
): Promise<void> {
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }),
  );
}

export async function getObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<string> {
  const res = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  return (await res.Body?.transformToString()) ?? "";
}

export async function listObjectKeys(
  client: S3Client,
  bucket: string,
  prefix: string,
  maxKeys = 5,
): Promise<Array<string>> {
  const res = await client.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: maxKeys,
    }),
  );
  return (res.Contents ?? [])
    .map((c) => c.Key)
    .filter((k): k is string => typeof k === "string");
}

export async function deleteObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<void> {
  await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
