import { describe, expect, it } from "vitest";
import {
  ensureGithubEnvironment,
  readGithubState,
  readVercelState,
  writeGithub,
  writeVercel,
  type CommandRunner,
} from "./remote-state.ts";

/**
 * The I/O half. Two properties matter more than the happy path:
 *
 *   1. a secret value must never appear in a process argument list, because argv is
 *      world-readable via `ps`; and
 *   2. every failure must return null/false rather than throw, because a sync that
 *      dies halfway leaves the stores in a state nobody can describe.
 */
interface Call {
  args: string[];
  input: string | undefined;
}

const recorder = (output = ""): { runner: CommandRunner; calls: Call[] } => {
  const calls: Call[] = [];
  const runner: CommandRunner = (_command, args, input) => {
    calls.push({ args, input });
    return output;
  };
  return { runner, calls };
};

describe("writeGithub", () => {
  it("sends the value on stdin, never in argv", () => {
    // `gh secret set NAME --body sk-live-...` puts the key in `ps aux` output for as
    // long as gh runs. This is the regression test for that.
    const { runner, calls } = recorder();
    const value = "sk-live-0123456789abcdef";
    expect(writeGithub({ name: "LLM_API_KEY", kind: "secret", target: "environment:staging" }, value, "staging", runner)).toBe(true);

    const [call] = calls;
    expect(call!.input).toBe(value);
    expect(call!.args.join(" ")).not.toContain(value);
    expect(call!.args).not.toContain("--body");
  });

  it("scopes an environment value to the environment, and a repo value to the repo", () => {
    const scoped = recorder();
    writeGithub({ name: "LLM_API_KEY", kind: "secret", target: "environment:staging" }, "v", "staging", scoped.runner);
    expect(scoped.calls[0]!.args).toEqual(["secret", "set", "LLM_API_KEY", "--env", "staging"]);

    const repo = recorder();
    writeGithub({ name: "VERCEL_TOKEN", kind: "secret", target: "repo" }, "v", "staging", repo.runner);
    expect(repo.calls[0]!.args).toEqual(["secret", "set", "VERCEL_TOKEN"]);
  });

  it("maps prod to the production environment", () => {
    const { runner, calls } = recorder();
    writeGithub({ name: "LLM_API_KEY", kind: "secret", target: "environment:production" }, "v", "prod", runner);
    expect(calls[0]!.args).toContain("production");
    expect(calls[0]!.args.join(" ")).not.toMatch(/PROD|STAGING/);
  });

  it("writes a non-secret as a variable, not a secret", () => {
    const { runner, calls } = recorder();
    writeGithub({ name: "LLM_PRIMARY_MODEL", kind: "variable", target: "environment:staging" }, "m", "staging", runner);
    expect(calls[0]!.args[0]).toBe("variable");
  });

  it("reports failure instead of throwing", () => {
    const failing: CommandRunner = () => {
      throw new Error("gh: not authenticated");
    };
    expect(
      writeGithub({ name: "LLM_API_KEY", kind: "secret", target: "environment:staging" }, "v", "staging", failing),
    ).toBe(false);
  });
});

describe("ensureGithubEnvironment", () => {
  it("creates the environment by its real name", () => {
    const { runner, calls } = recorder();
    expect(ensureGithubEnvironment("prod", runner)).toBe(true);
    expect(calls[0]!.args.join(" ")).toContain("/environments/production");
  });

  it("reports failure rather than throwing", () => {
    const failing: CommandRunner = () => {
      throw new Error("403");
    };
    expect(ensureGithubEnvironment("staging", failing)).toBe(false);
  });
});

describe("readGithubState", () => {
  it("returns null when the store cannot be read, so nothing is guessed", () => {
    // The caller turns null into `blocked`. Returning an empty state instead would
    // read as "everything is missing" and invite a full rewrite.
    const failing: CommandRunner = () => {
      throw new Error("gh: not authenticated");
    };
    expect(readGithubState("staging", failing)).toBeNull();
  });

  it("separates secrets (names only) from variables (values)", () => {
    // gh api <path> --jq <expr>: the path is args[1]. Repo-level reads answer; the
    // environment reads below them return nothing, which is the "empty but existing"
    // environment this test is about.
    const runner: CommandRunner = (_command, args) => {
      const path = args[1] ?? "";
      if (path.endsWith("/actions/secrets")) return "LLM_API_KEY\nGUEST_COOKIE_SECRET\n";
      if (path.endsWith("/actions/variables")) return "LLM_PRIMARY_MODEL\tgemini-3.6-flash\n";
      return "";
    };
    const state = readGithubState("staging", runner);
    expect(state).not.toBeNull();
    expect(state!.repoSecrets.has("LLM_API_KEY")).toBe(true);
    expect(state!.repoVariables.get("LLM_PRIMARY_MODEL")).toBe("gemini-3.6-flash");
    // A secret has no value to compare — that is the whole reason for skip-present.
    expect(state!.repoVariables.has("LLM_API_KEY")).toBe(false);
  });
});

describe("writeVercel", () => {
  const state = {
    target: "preview" as const,
    entries: new Map<string, string | null>(),
    ids: new Map<string, string>(),
  };
  const source = { VERCEL_PROJECT_ID: "prj_1", VERCEL_TOKEN: "tok", VERCEL_ORG_ID: "team_1" };

  it("creates a variable on the target it was told, not on every target", async () => {
    const bodies: unknown[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    const row = { name: "REVIEW_API_URL", target: "vercel:preview" };
    expect(await writeVercel(row, "https://api.staging.example.com", state, "create", source, fake)).toBe(true);
    expect(bodies[0]).toMatchObject({
      key: "REVIEW_API_URL",
      target: ["preview"],
      type: "encrypted",
    });
  });

  it("updates by id instead of creating a duplicate", async () => {
    const urls: string[] = [];
    const fake = (async (url: string) => {
      urls.push(url);
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    const withId = { ...state, ids: new Map([["REVIEW_API_URL", "env_9"]]) };
    await writeVercel({ name: "REVIEW_API_URL", target: "vercel:preview" }, "v", withId, "update", source, fake);
    expect(urls[0]).toContain("/env/env_9");
  });

  it("refuses to run without a token, rather than calling unauthenticated", async () => {
    let called = false;
    const fake = (async () => {
      called = true;
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    expect(await writeVercel({ name: "X", target: "vercel:preview" }, "v", state, "create", {}, fake)).toBe(false);
    expect(called).toBe(false);
  });

  it("returns false on a network failure", async () => {
    const fake = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(
      await writeVercel({ name: "X", target: "vercel:preview" }, "v", state, "create", source, fake),
    ).toBe(false);
  });
});

describe("readVercelState", () => {
  it("reads the target it was asked for", async () => {
    const fake = (async () =>
      ({
        ok: true,
        json: async () => ({
          envs: [
            { key: "REVIEW_API_URL", target: ["preview"], value: "https://api.staging.example.com", id: "e1" },
            { key: "OTHER", target: ["production"], value: "nope", id: "e2" },
          ],
        }),
      }) as unknown as Response) as unknown as typeof fetch;

    const state = await readVercelState("staging", { VERCEL_PROJECT_ID: "prj_1", VERCEL_TOKEN: "tok" }, fake);
    expect(state).not.toBeNull();
    expect(state!.entries.get("REVIEW_API_URL")).toBe("https://api.staging.example.com");
    // A value scoped to a different target must not be adopted as this one's.
    expect(state!.entries.has("OTHER")).toBe(false);
  });

  it("returns null when Vercel is unreachable", async () => {
    const fake = (async () => {
      throw new Error("ENOTFOUND");
    }) as unknown as typeof fetch;
    expect(
      await readVercelState("staging", { VERCEL_PROJECT_ID: "prj_1", VERCEL_TOKEN: "tok" }, fake),
    ).toBeNull();
  });
});
