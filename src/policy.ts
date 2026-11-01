import type { AutoApproveRule } from "./config.ts";

export interface ApprovalChoice {
  choiceId: string;
  decision: string;
  scope: string;
  label?: string;
  acceptsFeedback?: boolean;
}

/** The fields muse_decide and the policy matcher need. The rest of the MSP payload is kept intact by the broker. */
export interface ApprovalSubjectView {
  approvalId: string;
  toolName?: string;
  rawArgs?: string;
  subject?: {
    kind?: string;
    command?: string;
    host?: string;
    path?: string;
    toolName?: string;
  };
  availableChoices: ApprovalChoice[];
}

export type ChoiceSelection =
  | { ok: true; choiceId: string; feedback?: string }
  | { ok: false; error: string; choices: ApprovalChoice[] };

export function canonicalSubject(view: ApprovalSubjectView): string {
  const subject = view.subject ?? {};
  return [view.toolName, subject.kind, subject.command, subject.host, subject.path, subject.toolName, view.rawArgs]
    .filter((part) => part !== undefined && part !== "")
    .join(" ");
}

export function matchPolicy(rules: readonly AutoApproveRule[], line: string): AutoApproveRule | undefined {
  for (const rule of rules) {
    if (rule.decision !== "approve") continue;
    if (new RegExp(rule.match).test(line)) return rule;
  }
  return undefined;
}

/**
 * approve picks the offered once-only approval. deny picks a once-only
 * denied choice, otherwise a once-only abort (this CLI's Reject). Persistent
 * allows are never selected for a plain approve.
 */
export function selectChoice(
  choices: readonly ApprovalChoice[],
  decision: "approve" | "deny",
  reason?: string,
): ChoiceSelection {
  const choice = decision === "approve" ? onceApproved(choices) : rejectChoice(choices);
  if (!choice) {
    const verb = decision === "approve" ? "once-approve" : "reject";
    return {
      ok: false,
      error: `no ${verb} choice offered`,
      choices: choices.map((item) => ({ ...item })),
    };
  }
  const feedback = reason && choice.acceptsFeedback === true ? reason : undefined;
  return { ok: true, choiceId: choice.choiceId, feedback };
}

function onceApproved(choices: readonly ApprovalChoice[]): ApprovalChoice | undefined {
  return choices.find((choice) => choice.decision === "approved" && choice.scope === "once");
}

function rejectChoice(choices: readonly ApprovalChoice[]): ApprovalChoice | undefined {
  return (
    choices.find((choice) => choice.decision === "denied" && choice.scope === "once") ??
    choices.find((choice) => choice.decision === "abort" && choice.scope === "once") ??
    choices.find((choice) => choice.decision === "denied" || choice.decision === "abort")
  );
}
