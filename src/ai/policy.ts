/**
 * S05-02 — one gate that answers "is this property allowed to answer, here,
 * now, on this topic, within budget?".
 *
 * S05-01 evaluated the policy causes inline because it needed them separately
 * for its outcome type. This module is the same rules with the budget added and
 * a single return shape, so every caller asks the question once and gets the
 * same answer — the failure this prevents is two call sites disagreeing about
 * whether `draft` mode means "draft it for staff" or "send it".
 *
 * The spend cap is CONSUMED, not implemented: `spendTodayUsd` is supplied by the
 * caller (S07-04 owns the counter, because the counter has to survive across
 * requests and this module is pure). A missing counter means "no budget
 * information", which is different from "over budget" — the gate allows in the
 * first case and refuses in the second, and says which one it did.
 */
import type { AiReasonCode } from "./contract.ts";
import { escalationDecision, isAfterHours, isTopicEnabled, spendCaps, type AiMode } from "../settings/policy.ts";
import type { PropertySettings } from "../settings/schema.ts";

export interface PolicyInput {
  settings: PropertySettings;
  aiMode: AiMode;
  /** Null when classification has not run: the topic rules cannot be evaluated. */
  topicKey: string | null;
  at: Date;
  timeZone: string;
  /** Spend so far today, in USD — from S07-04's counter. Omit when unknown. */
  spendTodayUsd?: number;
  /** Spend so far in this conversation, in USD. */
  conversationSpendUsd?: number;
}

export interface PolicyDecision {
  allow: boolean;
  /** Null when allowed. */
  reasonCode: AiReasonCode | null;
  /** Machine-readable cause, e.g. "mode_draft" or "daily_spend_cap". */
  detail: string;
  /** True when topic-scoped rules were skipped because no topic was known. */
  topicUnclassified: boolean;
}

const ALLOW: PolicyDecision = {
  allow: true,
  reasonCode: null,
  detail: "allowed",
  topicUnclassified: false,
};

export function policyGate(input: PolicyInput): PolicyDecision {
  // 1. Mode and after-hours. `escalationDecision` is the staff-facing
  //    composition and is used when a topic is known, so the topic rule comes
  //    from the same place for both callers.
  if (input.topicKey !== null) {
    const decision = escalationDecision(input.settings, {
      aiMode: input.aiMode,
      topicKey: input.topicKey,
      at: input.at,
      timeZone: input.timeZone,
    });
    if (decision.escalate) {
      return {
        allow: false,
        reasonCode: "policy_block",
        detail: decision.reason ?? "policy_block",
        topicUnclassified: false,
      };
    }
  } else {
    // No topic: the mode rules still apply, the topic rule cannot.
    if (input.aiMode === "human_only") {
      return { allow: false, reasonCode: "policy_block", detail: "mode_human_only", topicUnclassified: true };
    }
    if (input.aiMode === "draft") {
      return { allow: false, reasonCode: "policy_block", detail: "mode_draft", topicUnclassified: true };
    }
    if (input.aiMode === "after_hours" && isAfterHours(input.settings, input.at, input.timeZone)) {
      return { allow: false, reasonCode: "policy_block", detail: "after_hours", topicUnclassified: true };
    }
  }

  // 2. Budget. Both caps exist in settings (S02-02); the counter is S07-04's.
  const caps = spendCaps(input.settings);
  if (input.spendTodayUsd !== undefined && input.spendTodayUsd >= caps.dailyUsd) {
    return { allow: false, reasonCode: "policy_block", detail: "daily_spend_cap", topicUnclassified: input.topicKey === null };
  }
  if (
    input.conversationSpendUsd !== undefined &&
    input.conversationSpendUsd >= caps.perConversationUsd
  ) {
    return {
      allow: false,
      reasonCode: "policy_block",
      detail: "conversation_spend_cap",
      topicUnclassified: input.topicKey === null,
    };
  }

  return { ...ALLOW, topicUnclassified: input.topicKey === null };
}

/** Re-exported so a caller does not have to import two policy modules. */
export { isTopicEnabled };
