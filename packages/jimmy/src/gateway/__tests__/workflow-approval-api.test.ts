import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { handleWorkflowApi } from "../workflow-api.js";
import type { WorkflowService } from "../../workflows/service.js";

/* The approval round-trip the web buttons and `ryoko workflow approve` ride:
 * this suite pins the HTTP contract itself — the exact body keys the route
 * accepts, and who the decided-by actor is when no caller header rides along —
 * because a client sending one wrong key gets a 422 no unit test of the
 * service would ever catch. */

function fakeRequest(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const readable = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  readable.headers = { "content-type": "application/json", ...headers };
  readable.method = "POST";
  return readable;
}

function fakeResponse(): { res: ServerResponse; read: () => { status: number; body: unknown } } {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    getHeader() { return undefined; },
    end(chunk?: unknown) { if (chunk) chunks.push(String(chunk)); },
  } as unknown as ServerResponse;
  return { res, read: () => ({ status, body: chunks.length ? JSON.parse(chunks.join("")) : null }) };
}

function route(pathname: string): { method: string; pathname: string; url: URL } {
  return { method: "POST", pathname, url: new URL(`http://ryoko${pathname}`) };
}

const APPROVAL_PATH = "/api/workflows/flow/runs/run-1/nodes/approve/approval";

describe("the approval route contract", () => {
  it("accepts {decision, expectedRevision, reason} and stamps the operator actor", async () => {
    const decideApproval = vi.fn().mockResolvedValue({ id: "run-1", status: "running" });
    const service = { decideApproval } as unknown as WorkflowService;

    const { res, read } = fakeResponse();
    const handled = await handleWorkflowApi(
      fakeRequest({ decision: "approve", expectedRevision: 3, reason: "確認済み" }),
      res, route(APPROVAL_PATH), { service, authenticated: true },
    );

    expect(handled).toBe(true);
    expect(read().status).toBe(200);
    expect(decideApproval).toHaveBeenCalledWith({
      workflowId: "flow", runId: "run-1", nodeId: "approve",
      decision: "approve", expectedRevision: 3, reason: "確認済み",
      decidedBy: "operator", // no caller-session header → the human operator
    });
  });

  it("refuses unknown body keys — the 422 a stale client would hit", async () => {
    const decideApproval = vi.fn();
    const service = { decideApproval } as unknown as WorkflowService;

    const { res, read } = fakeResponse();
    await handleWorkflowApi(
      fakeRequest({ decision: "approve", expectedRevision: 3, decidedBy: "operator" }),
      res, route(APPROVAL_PATH), { service, authenticated: true },
    );

    expect(read().status).toBe(422);
    expect(decideApproval).not.toHaveBeenCalled();
  });

  it("refuses writes without authentication", async () => {
    const service = { decideApproval: vi.fn() } as unknown as WorkflowService;
    const { res, read } = fakeResponse();
    await handleWorkflowApi(
      fakeRequest({ decision: "approve", expectedRevision: 3 }),
      res, route(APPROVAL_PATH), { service, authenticated: false },
    );
    expect(read().status).toBe(401);
  });
});
