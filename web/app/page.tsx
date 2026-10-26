import { redirect } from "next/navigation";
import { readSession } from "@/lib/session";

export default async function Home(): Promise<never> {
  const session = await readSession();
  redirect(session === null ? "/session" : "/review");
}
