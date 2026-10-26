import { cookies } from "next/headers";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { currentLang, LANG_COOKIE, normalizeLang, translator } from "@/lib/i18n";
import { ORG_COOKIE, PROPERTY_COOKIE } from "@/lib/session";
import { saveSession } from "./actions";

export default async function SessionPage({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string }>;
}): Promise<React.ReactElement> {
  const lang = await currentLang();
  const tr = translator(lang);
  const jar = await cookies();
  const problem = (await searchParams).problem;

  return (
    <Card className="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle>{tr("staff.session.title")}</CardTitle>
        <CardDescription>{tr("staff.session.help")}</CardDescription>
      </CardHeader>
      <CardContent>
        {problem === "invalid" ? (
          <p className="mb-4 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive">
            {tr("staff.review.error")}
          </p>
        ) : null}
        <form action={saveSession} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="token">{tr("staff.session.token")}</Label>
            <Input id="token" name="token" type="password" autoComplete="off" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="orgId">{tr("staff.session.org")}</Label>
            <Input id="orgId" name="orgId" defaultValue={jar.get(ORG_COOKIE)?.value ?? ""} required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="propertyId">{tr("staff.session.property")}</Label>
            <Input
              id="propertyId"
              name="propertyId"
              defaultValue={jar.get(PROPERTY_COOKIE)?.value ?? ""}
              required
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="lang">{tr("staff.session.language")}</Label>
            <select
              id="lang"
              name="lang"
              defaultValue={normalizeLang(jar.get(LANG_COOKIE)?.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="es">Español</option>
              <option value="en">English</option>
            </select>
          </div>
          <Button type="submit">{tr("staff.session.submit")}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
