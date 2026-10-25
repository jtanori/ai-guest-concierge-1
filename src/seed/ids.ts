import crypto from "node:crypto";

const SEED_NAMESPACE = "c0a80101-0000-5000-8000-000000000001";

function namespaceBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
}

export function stableUuid(key: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(Buffer.concat([namespaceBytes(SEED_NAMESPACE), Buffer.from(key, "utf8")]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const DEMO_ORG_ID = stableUuid("org:demo");
export const DEMO_PROPERTY_ID = stableUuid("property:demo");
export const DEMO_SOURCE_ID = stableUuid("source:demo-manual");
export const DEMO_GAP_ID = stableUuid("gap:noticeboard-parking");

export const DEMO_STAFF = [
  {
    key: "owner",
    userId: stableUuid("user:demo-owner"),
    email: "owner@demo.hotelparaiso.mx",
    displayName: "Demo Owner",
    roleId: 1,
  },
  {
    key: "manager",
    userId: stableUuid("user:demo-manager"),
    email: "manager@demo.hotelparaiso.mx",
    displayName: "Demo Manager",
    roleId: 2,
  },
  {
    key: "front_desk",
    userId: stableUuid("user:demo-front-desk"),
    email: "frontdesk@demo.hotelparaiso.mx",
    displayName: "Demo Front Desk",
    roleId: 3,
  },
  {
    key: "observer",
    userId: stableUuid("user:demo-observer"),
    email: "observer@demo.hotelparaiso.mx",
    displayName: "Demo Observer",
    roleId: 4,
  },
] as const;
