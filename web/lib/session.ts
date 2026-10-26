import { cookies } from "next/headers";

/**
 * Where the staff token lives. HttpOnly on purpose: the browser can send it
 * but cannot read it, and the proxy route below is the only thing that puts
 * it on the wire to the API.
 */
export const TOKEN_COOKIE = "staff_token";
export const ORG_COOKIE = "staff_org";
export const PROPERTY_COOKIE = "staff_property";

export interface StaffCookieSession {
  token: string;
  orgId: string;
  propertyId: string;
}

export async function readSession(): Promise<StaffCookieSession | null> {
  const jar = await cookies();
  const token = jar.get(TOKEN_COOKIE)?.value ?? "";
  const orgId = jar.get(ORG_COOKIE)?.value ?? "";
  const propertyId = jar.get(PROPERTY_COOKIE)?.value ?? "";
  if (token === "" || orgId === "" || propertyId === "") return null;
  return { token, orgId, propertyId };
}

export { apiBase } from "./api-base";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
