import { redirect } from "next/navigation";
import { currentLang, translator, type StringId } from "@/lib/i18n";
import { apiBase, readSession } from "@/lib/session";
import type { AiModeStateWire, ApiFailure } from "@/lib/types";
import { saveModeAction } from "./actions";

/**
 * S08-04 — the operating-mode screen.
 *
 * AC-1 (`auto | draft | human_only | after_hours`, per property) and AC-2 (the
 * flip applies to the very next message, no restart).
 *
 * There is no client state and no polling: the page reads the mode on each
 * render, and the save is a server action that redirects back into this page.
 * That is the whole "no restart" story — nothing between the database and
 * `answerMessage` caches the value, so nothing has to be invalidated.
 *
 * The current mode is read from the API, not from the form: a second admin on a
 * phone must see what is actually set, not what this tab last submitted.
 */
const MODES = [
  { value: "auto", label: "staff.mode.auto", hint: "staff.mode.auto_hint" },
  { value: "draft", label: "staff.mode.draft", hint: "staff.mode.draft_hint" },
  { value: "human_only", label: "staff.mode.human_only", hint: "staff.mode.human_only_hint" },
  { value: "after_hours", label: "staff.mode.after_hours", hint: "staff.mode.after_hours_hint" },
] as const;

const PROBLEMS = {
  saved: "staff.mode.saved",
  unchanged: "staff.mode.unchanged",
  invalid: "staff.mode.error_invalid",
  forbidden: "staff.mode.error_forbidden",
  error: "staff.mode.error_other",
} as const;

const GOOD = new Set(["saved", "unchanged"]);

async function loadMode(): Promise<
  { ok: true; state: AiModeStateWire } | { ok: false; status: number; error: string }
> {
  const session = await readSession();
  if (session === null) redirect("/session");
  try {
    const response = await fetch(`${apiBase()}/api/settings/ai-mode`, {
      headers: {
        authorization: `Bearer ${session.token}`,
        "x-org-id": session.orgId,
        "x-property-id": session.propertyId,
      },
      cache: "no-store",
    });
    const body = (await response.json().catch(() => ({ error: "invalid_response" }))) as
      | AiModeStateWire
      | ApiFailure;
    if (!response.ok) {
      return { ok: false, status: response.status, error: (body as ApiFailure).error };
    }
    return { ok: true, state: body as AiModeStateWire };
  } catch {
    return { ok: false, status: 502, error: "upstream_unreachable" };
  }
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ problem?: string }>;
}): Promise<React.ReactElement> {
  const lang = await currentLang();
  const tr = translator(lang);
  const { problem } = await searchParams;
  const loaded = await loadMode();

  if (!loaded.ok) {
    return (
      <div className="space-y-2 rounded-lg border border-destructive/40 p-6">
        <h1 className="text-lg font-semibold">{tr("staff.mode.title")}</h1>
        <p className="text-sm text-destructive">{tr("staff.mode.error_forbidden")}</p>
        <p className="text-[11px] text-muted-foreground">
          {loaded.error} · HTTP {loaded.status}
        </p>
      </div>
    );
  }

  const state = loaded.state;
  const problemId =
    problem === undefined ? null : PROBLEMS[problem as keyof typeof PROBLEMS] ?? "staff.mode.error_other";

  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-lg font-semibold tracking-tight">{tr("staff.mode.title")}</h1>
        <p className="text-xs text-muted-foreground">{tr("staff.mode.intro")}</p>
      </header>

      {problemId === null ? null : (
        <p
          className={
            GOOD.has(problem ?? "")
              ? "rounded border p-2 text-xs"
              : "rounded border border-destructive/40 p-2 text-xs text-destructive"
          }
        >
          {tr(problemId as StringId)}
        </p>
      )}

      <p className="text-sm">
        {tr("staff.mode.current")}: <strong>{tr(`staff.mode.${state.aiMode}` as StringId)}</strong>
      </p>

      <form action={saveModeAction} className="space-y-3">
        <fieldset className="space-y-2">
          <legend className="sr-only">{tr("staff.mode.title")}</legend>
          {MODES.map((mode) => (
            <label
              key={mode.value}
              className="flex cursor-pointer items-start gap-2 rounded border p-3 text-sm"
            >
              <input
                type="radio"
                name="mode"
                value={mode.value}
                defaultChecked={state.aiMode === mode.value}
                className="mt-0.5"
              />
              <span className="space-y-0.5">
                <span className="block font-medium">{tr(mode.label)}</span>
                <span className="block text-[11px] text-muted-foreground">{tr(mode.hint)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        <p className="text-[11px] text-muted-foreground">
          {tr("staff.mode.timezone").replace("{zone}", state.timeZone)}
        </p>
        <button
          type="submit"
          className="rounded bg-foreground px-3 py-1.5 text-xs font-medium text-background"
        >
          {tr("staff.mode.save")}
        </button>
      </form>
    </div>
  );
}
