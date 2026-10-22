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

function wrongPrefixMessage(product: AgentProduct): string {
  const other = OTHER_PRODUCT[product];
  return (
    `This run_id starts with \`${RUN_ID_PREFIX[product]}\` on \`${AGENT_TOOL_NAME[product]}\`. ` +
    `A \`${RUN_ID_PREFIX[other]}\` id belongs to \`${AGENT_TOOL_NAME[other]}\`; call that tool instead.`
  );
}

export function toBackendRunId(
  product: AgentProduct,
  publicRunId: string,
): string {
  const prefix = RUN_ID_PREFIX[product];
  if (!publicRunId.startsWith(prefix)) {
    throw new AgentInputError(wrongPrefixMessage(product));
  }
  return publicRunId.slice(prefix.length);
}

export function runIdInputSchema(product: AgentProduct): z.ZodString {
  return z
    .string()
    .regex(new RegExp(`^${RUN_ID_PREFIX[product]}`), {
      message: wrongPrefixMessage(product),
    })
    .describe(
      "A `run_id` from an earlier call that returned `status: running`. Send it instead of `query` to keep waiting for that run.",
    );
}
