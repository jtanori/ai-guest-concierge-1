"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { ApiFailure, ContradictionWire, ReviewQueueItemWire } from "@/lib/types";

export interface ReviewLabels {
  title: string;
  pending: string;
  approve: string;
  reject: string;
  approved: string;
  rejected: string;
  contradictions: string;
  resolve: string;
  resolved: string;
  empty: string;
  article: string;
  version: string;
  value: string;
  winner: string;
  error: string;
}

interface Props {
  labels: ReviewLabels;
  pending: ReviewQueueItemWire[];
  contradictions: ContradictionWire[];
}

function statusVariant(status: ReviewQueueItemWire["status"]): "secondary" | "outline" {
  return status === "approved" ? "secondary" : "outline";
}

export function ReviewQueue({ labels, pending, contradictions }: Props): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const send = React.useCallback(
    async (key: string, path: string, body?: unknown): Promise<void> => {
      setBusy(key);
      setError(null);
      try {
        const response = await fetch(`/api/review${path}`, {
          method: "POST",
          headers: body === undefined ? undefined : { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!response.ok) {
          const failure = (await response.json().catch(() => ({ error: "unknown" }))) as ApiFailure;
          // 403 keeps the API's reason: "role_not_on_surface" is the answer a
          // front_desk user needs, not a generic failure.
          setError(`${labels.error} (${failure.error})`);
          return;
        }
        router.refresh();
      } catch {
        setError(labels.error);
      } finally {
        setBusy(null);
      }
    },
    [labels.error, router],
  );

  return (
    <div className="flex flex-col gap-6">
      {error === null ? null : (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive"
        >
          {error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{labels.pending}</CardTitle>
          <CardDescription>{labels.title}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {pending.length === 0 ? (
            <p className="text-sm text-muted-foreground">{labels.empty}</p>
          ) : (
            pending.map((item) => {
              const key = `version:${item.articleVersionId}`;
              return (
                <div
                  key={key}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-xs text-muted-foreground">
                      {item.articleId}
                    </span>
                    <span className="text-sm">
                      {labels.version} {item.versionNo}
                      {item.isCurrent ? ` · ${labels.approved}` : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusVariant(item.status)}>{item.status}</Badge>
                    <Button
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void send(`${key}:approve`, `/versions/${item.articleVersionId}/approve`)}
                    >
                      {labels.approve}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      onClick={() => void send(`${key}:reject`, `/versions/${item.articleVersionId}/reject`)}
                    >
                      {labels.reject}
                    </Button>
                  </div>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{labels.contradictions}</CardTitle>
          <CardDescription>{labels.winner}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {contradictions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{labels.empty}</p>
          ) : (
            contradictions.map((group) => {
              const groupKey = `${group.topicKey}|${group.factKey}|${group.language}|${group.effectiveFrom ?? ""}`;
              return (
                <div key={groupKey} className="rounded-md border p-3">
                  <p className="text-sm font-medium">
                    {group.topicKey} · {group.factKey}
                    <span className="ml-2 text-xs text-muted-foreground">
                      {group.language}
                      {group.effectiveFrom === null ? "" : ` · ${group.effectiveFrom}`}
                    </span>
                  </p>
                  <ul className="mt-2 flex flex-col gap-2">
                    {group.entries.map((entry) => {
                      const entryKey = `${groupKey}|${entry.factId}`;
                      return (
                        <li
                          key={entryKey}
                          className="flex flex-wrap items-center justify-between gap-2"
                        >
                          <span className="text-sm">{entry.value}</span>
                          <span className="flex items-center gap-2">
                            {entry.verified ? <Badge variant="secondary">{labels.approved}</Badge> : null}
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy !== null}
                              onClick={() =>
                                void send(`${entryKey}:resolve`, "/contradictions/resolve", {
                                  topicKey: group.topicKey,
                                  factKey: group.factKey,
                                  language: group.language,
                                  effectiveFrom: group.effectiveFrom,
                                  winnerFactId: entry.factId,
                                })
                              }
                            >
                              {labels.resolve}
                            </Button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
