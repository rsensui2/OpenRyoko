import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { buildNodeContract } from "../contract.js";
import type { EmployeeNode, WorkflowOutputSchema } from "../model.js";

function employeeNode(output?: WorkflowOutputSchema): EmployeeNode {
  return {
    id: "draft",
    type: "employee",
    name: "Draft",
    config: {
      employee: { source: "fixed", value: "writer" },
      prompt: "Draft the release.",
      ...(output ? { output } : {}),
    },
  };
}

describe("workflow node completion contract", () => {
  it("renders every declared field with type, required marker, and description", () => {
    const contract = buildNodeContract(employeeNode({
      fields: {
        title: { type: "string", required: true, description: "Published title" },
        score: { type: "number", required: false, description: "Confidence | 0-100" },
      },
      allowAdditionalFields: false,
    }), []);

    expect(contract).toContain("| `title` | string | yes | Published title |");
    expect(contract).toContain("| `score` | number | no | Confidence \\| 0-100 |");
    expect(contract).toContain("call the `workflow_submit_output` tool with these fields");
  });

  it("tells the employee how to produce an attachment ref, only when one is declared", () => {
    const withAttachment = buildNodeContract(employeeNode({
      fields: { shot: { type: "attachment", required: true }, notes: { type: "attachment[]", required: false } },
      allowAdditionalFields: false,
    }), []);

    expect(withAttachment).toContain("| `shot` | attachment | yes |  |");
    expect(withAttachment).toContain("| `notes` | attachment[] | no |  |");
    expect(withAttachment).toContain("attach_to_work_item");
    expect(withAttachment).toContain("attachment:<TODO-ID>:<attachment-id>:<mime>");

    const withoutAttachment = buildNodeContract(employeeNode({
      fields: { title: { type: "string", required: true } },
      allowAdditionalFields: false,
    }), []);

    expect(withoutAttachment).not.toContain("attach_to_work_item");
  });

  it("omits the field table when no structured output schema is declared", () => {
    const contract = buildNodeContract(employeeNode(), []);

    expect(contract).not.toContain("| Field |");
    expect(contract).toContain("Calling `workflow_submit_output` is what completes this workflow step");
    expect(contract).toContain("```jinn-output");
  });

  it("lists readable upstream sessions and omits entries without a session", () => {
    const contract = buildNodeContract(employeeNode(), [
      { nodeId: "research", sessionId: "session-research" },
      { nodeId: "approval" },
      { nodeId: "review", sessionId: "session-review" },
    ]);

    expect(contract).toContain("read_session");
    expect(contract).toContain("get_message_context");
    expect(contract).toContain("`research: session-research`");
    expect(contract).toContain("`review: session-review`");
    expect(contract).not.toContain("`approval:");
  });

  it("stays below 4 KiB for a twenty-field schema", () => {
    const fields = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [
      `field_${index}`,
      { type: "string" as const, required: index % 2 === 0, description: `Field ${index} result` },
    ]));
    const contract = buildNodeContract(employeeNode({ fields, allowAdditionalFields: false }), []);

    expect(Buffer.byteLength(contract, "utf8")).toBeLessThan(4 * 1024);
  });
});
