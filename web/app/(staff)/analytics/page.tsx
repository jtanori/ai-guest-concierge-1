import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { currentLang, translator, type StringId } from "@/lib/i18n";
import { apiBase, readSession, type StaffCookieSession } from "@/lib/session";
import type { ApiFailure, DashboardTileWire, DashboardWire } from "@/lib/types";
import { signOut } from "../session/actions";

/**
 * S10-03 — the management dashboard.
 *
 * AC (verbatim): *"Every tile traceable to a query a manager can explain."* The
 * traceability is the screen: each tile names its `rollups.metric`, prints the
 * value exactly as it was stored, and opens onto the SQL that produced it. A
 * manager who doubts a number can read the statement that made it — which is the
 * whole difference between a dashboard and a wall of numbers.
 *
 * ## Why the value is a string all the way from the column
 *
 * `src/analytics/dashboard.ts` sends `rollups.value` as text. Nothing here parses
 * it except to *format* it (a ratio becomes "57.1%", a duration becomes "4.0 s"),
 * and the raw stored text is printed beside the formatted number. AC-2 says the
 * numbers match `rollups` exactly with no client-side recomputation; the surest
 * proof is that the unformatted value is on the same card the formatted one is.
 *
 * ## Why there is no total
 *
 * A range shows the stored days; the tile's headline is the most recent stored
 * day. A "week total" would be arithmetic the rollup never made, and then the
 * query disclosure would be a lie. Weekly totals belong in `rollups` as their own
 * metric if anybody wants them.
 *
 * ## Server component, no client JS
 *
 * Like every other staff surface: one GET, one render, a plain GET form for the
 * dates. A manager looking at last week on a phone in a lobby does not need a
 * hydration step between them and the number.
 */
interface Loaded {
  status: number;
  body: DashboardWire | ApiFailure;
}

async function load(
  session: StaffCookieSession,
  from: string | null,
  to: string | null,
): Promise<Loaded> {
  const query = new URLSearchParams();
  if (from !== null) query.set("from", from);
  if (to !== null) query.set("to", to);
  const suffix = query.toString() === "" ? "" : `?${query.toString()}`;
  try {
    const response = await fetch(`${apiBase()}/api/analytics${suffix}`, {
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-org-id": session.orgId,
        "x-property-id": session.propertyId,
      },
      cache: "no-store",
    });
    const parsed = (await response.json().catch(() => ({
      error: "invalid_response",
    }))) as DashboardWire | ApiFailure;
    return { status: response.status, body: parsed };
  } catch {
    return { status: 502, body: { error: "upstream_unreachable" } };
  }
}

/**
 * Presentation only: the stored text, rendered for a human, in the reader's
 * language. No arithmetic crosses a metric boundary — a percentage is one stored
 * ratio expressed differently, a duration is one stored count of seconds.
 */
function formatValue(
  tile: DashboardTileWire,
  value: string,
  lang: string,
): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  if (tile.unit === "ratio") return `${(numeric * 100).toFixed(1)}%`;
  if (tile.unit === "seconds") {
    // Same unit in both languages ("min", "s"); the words around it are copied.
    return numeric >= 60 ? `${(numeric / 60).toFixed(1)} min` : `${numeric.toFixed(1)} s`;
  }
  return numeric.toLocaleString(lang === "es" ? "es-MX" : "en-US");
}

/** A tile with no stored day in the range. */
function EmptyTile({
  tile,
  tr,
}: {
  tile: DashboardTileWire;
  tr: (id: StringId) => string;
}): React.ReactElement {
  return (
    <div className="rounded-lg border border-dashed p-4">
      <p className="text-xs font-medium">{tr(tile.labelId as StringId)}</p>
      <p className="mt-2 text-sm text-muted-foreground">{tr("staff.analytics.no_data")}</p>
      <QueryDisclosure tile={tile} tr={tr} />
    </div>
  );
}

/**
 * AC-1 in one element: the metric name a row would carry, and the statement that
 * produced it. `<details>` so it costs nothing until somebody asks, and so it
 * works with no JavaScript at all.
 */
function QueryDisclosure({
  tile,
  tr,
}: {
  tile: DashboardTileWire;
  tr: (id: StringId) => string;
}): React.ReactElement {
  return (
    <details className="mt-3 text-[11px]">
      <summary className="cursor-pointer text-muted-foreground">
        {tr("staff.analytics.show_query")}
      </summary>
      <p className="mt-2 text-muted-foreground">
        {tr("staff.analytics.metric")}: <code className="font-mono">{tile.metric}</code>
      </p>
      <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 font-mono text-[10px] leading-relaxed">
        {tile.querySql.trim()}
      </pre>
    </details>
  );
}

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const session = await readSession();
  if (session === null) redirect("/session");

  const params = await searchParams;
  const from = typeof params["from"] === "string" ? params["from"] : null;
  const to = typeof params["to"] === "string" ? params["to"] : null;

  const lang = await currentLang();
  const tr = translator(lang);
  const loaded = await load(session, from, to);

  if (loaded.status !== 200) {
    const forbidden = loaded.status === 403;
    const invalid = loaded.status === 400;
    return (
      <div className="rounded-lg border border-destructive/40 p-6">
        <p className="text-sm font-medium text-destructive">
          {forbidden
            ? tr("staff.analytics.forbidden")
            : invalid
              ? tr("staff.analytics.problem_invalid")
              : tr("staff.analytics.error")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {(loaded.body as ApiFailure).error} · HTTP {loaded.status}
        </p>
        <form action={signOut} className="mt-4">
          <Button type="submit" variant="outline" size="sm">
            {tr("staff.common.signout")}
          </Button>
        </form>
      </div>
    );
  }

  const dashboard = loaded.body as DashboardWire;
  const hasAnyNumber = dashboard.tiles.some((tile) => tile.latest !== null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-semibold tracking-tight">{tr("staff.analytics.title")}</h1>
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm">
            {tr("staff.common.signout")}
          </Button>
        </form>
      </div>
      <p className="text-xs text-muted-foreground">{tr("staff.analytics.intro")}</p>

      {/* A plain GET form: works before hydration, and the dates live in the URL
          so a manager can paste "last week" to somebody. */}
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-lg border p-4">
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">{tr("staff.analytics.from")}</span>
          <input
            type="date"
            name="from"
            defaultValue={dashboard.from}
            className="rounded border px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs">
          <span className="mb-1 block text-muted-foreground">{tr("staff.analytics.to")}</span>
          <input
            type="date"
            name="to"
            defaultValue={dashboard.to}
            className="rounded border px-2 py-1 text-sm"
          />
        </label>
        <Button type="submit" variant="outline" size="sm">
          {tr("staff.analytics.show")}
        </Button>
        <span className="ml-auto text-[11px] text-muted-foreground">
          {tr("staff.analytics.timezone").replace("{zone}", dashboard.timeZone)}
          {dashboard.generatedAt === null
            ? null
            : ` · ${tr("staff.analytics.computed").replace("{at}", dashboard.generatedAt)}`}
        </span>
      </form>

      {hasAnyNumber ? null : (
        <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
          {tr("staff.analytics.empty")}
        </p>
      )}

      <ul className="grid gap-3 sm:grid-cols-2">
        {dashboard.tiles.map((tile) =>
          tile.latest === null ? (
            <li key={tile.id}>
              <EmptyTile tile={tile} tr={tr} />
            </li>
          ) : (
            <li key={tile.id} className="rounded-lg border p-4">
              <p className="text-xs font-medium">{tr(tile.labelId as StringId)}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">
                {formatValue(tile, tile.latest.value, lang)}
              </p>
              <p className="text-[11px] text-muted-foreground">{tile.latest.windowStart}</p>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {tr(tile.descriptionId as StringId)}
              </p>
              {/* The stored value, verbatim: AC-2's evidence, on the card. */}
              <p className="mt-2 font-mono text-[10px] text-muted-foreground">
                {tile.latest.windowStart} → {tile.latest.value}
              </p>
              {tile.days.length > 1 ? (
                <p className="mt-2 text-[10px] text-muted-foreground">
                  {tr("staff.analytics.recent")}:{" "}
                  {tile.days
                    .slice()
                    .reverse()
                    .map((day) => `${day.windowStart} ${day.value}`)
                    .join(" · ")}
                </p>
              ) : null}
              <QueryDisclosure tile={tile} tr={tr} />
            </li>
          ),
        )}
      </ul>
    </div>
  );
}
