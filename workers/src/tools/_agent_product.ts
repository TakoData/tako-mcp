import { z } from "zod";

export type AgentProduct = "answer" | "company";

const OTHER_PRODUCT: Record<AgentProduct, AgentProduct> = {
  answer: "company",
  company: "answer",
};

export const AGENT_TOOL_NAME: Record<AgentProduct, string> = {
  answer: "tako_agent",
  company: "tako_company_agent",
};

export const RUN_ID_PREFIX: Record<AgentProduct, string> = {
  answer: "answer_run_",
  company: "company_run_",
};

export class AgentInputError extends Error {}

/** Backend path for starting and reading runs of a product. */
export function runsPath(product: AgentProduct): string {
  return `/api/v1/agent/${product}/runs`;
}

export function toPublicRunId(
  product: AgentProduct,
  backendRunId: string,
): string {
  return `${RUN_ID_PREFIX[product]}${backendRunId}`;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function runIdPattern(product: AgentProduct): RegExp {
  return new RegExp(`^${escapeRegExp(RUN_ID_PREFIX[product])}[A-Za-z0-9-]+$`);
}

function wrongPrefixMessage(product: AgentProduct): string {
  const other = OTHER_PRODUCT[product];
  return (
    `\`${AGENT_TOOL_NAME[product]}\` takes a run_id that starts with \`${RUN_ID_PREFIX[product]}\`. ` +
    `A \`${RUN_ID_PREFIX[other]}\` id belongs to \`${AGENT_TOOL_NAME[other]}\`; call that tool instead.`
  );
}

function malformedRunIdMessage(product: AgentProduct): string {
  return `This run_id isn't one \`${AGENT_TOOL_NAME[product]}\` returned. Send the \`run_id\` from an earlier \`status: running\` result unchanged.`;
}

function invalidRunIdMessage(product: AgentProduct, publicRunId: unknown): string {
  return typeof publicRunId === "string" && publicRunId.startsWith(RUN_ID_PREFIX[product])
    ? malformedRunIdMessage(product)
    : wrongPrefixMessage(product);
}

export function toBackendRunId(
  product: AgentProduct,
  publicRunId: string,
): string {
  if (!runIdPattern(product).test(publicRunId)) {
    throw new AgentInputError(invalidRunIdMessage(product, publicRunId));
  }
  return publicRunId.slice(RUN_ID_PREFIX[product].length);
}

export function runIdInputSchema(product: AgentProduct): z.ZodString {
  return z
    .string()
    .regex(runIdPattern(product), {
      error: (issue) => invalidRunIdMessage(product, issue.input),
    })
    .describe(
      "A `run_id` from an earlier call that returned `status: running`. Send it instead of `query` to keep waiting for that run.",
    );
}
