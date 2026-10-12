import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppConnector } from "../index.js";
import { logger } from "../../../shared/logger.js";

// The connector is never started here, so no socket is opened: the Baileys
// socket is replaced by a stub and the connection state is set directly.

const authDir = fs.mkdtempSync(path.join(os.tmpdir(), "wa-delivery-auth-"));
const JID = "447700900000@s.whatsapp.net";
let sendCounter = 0;

function connectedConnector() {
  const sendMessage = vi.fn(async (_jid: string, _content: { text: string }) => ({ key: { id: `W${++sendCounter}` } }));
  const connector = new WhatsAppConnector({ authDir });
  Object.assign(connector as unknown as Record<string, unknown>, {
    sock: { sendMessage },
    connectionStatus: "running",
  });
  return { connector, sendMessage };
}

describe("WhatsAppConnector delivery outcome", () => {
  beforeEach(() => {
    sendCounter = 0;
    vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    fs.rmSync(authDir, { recursive: true, force: true });
  });

  it("resolves with the last message id when the message is delivered", async () => {
    const { connector, sendMessage } = connectedConnector();

    await expect(connector.sendMessage({ channel: JID }, "hello")).resolves.toBe("W1");

    expect(sendMessage).toHaveBeenCalledWith(JID, { text: "hello" });
  });

  it("rejects instead of dropping the message while the socket is not connected", async () => {
    const connector = new WhatsAppConnector({ authDir });

    await expect(connector.sendMessage({ channel: JID }, "hello")).rejects.toThrow("not connected");
    await expect(connector.replyMessage({ channel: JID }, "hello")).rejects.toThrow("not connected");
  });

  it("rejects while the connector is waiting for a QR scan", async () => {
    const { connector, sendMessage } = connectedConnector();
    Object.assign(connector as unknown as Record<string, unknown>, { connectionStatus: "qr_pending" });

    await expect(connector.replyMessage({ channel: JID }, "hello")).rejects.toThrow("not connected");

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rejects when WhatsApp refuses the message", async () => {
    const { connector, sendMessage } = connectedConnector();
    sendMessage.mockRejectedValue(new Error("Connection Closed"));

    await expect(connector.replyMessage({ channel: JID }, "hello")).rejects.toThrow("Connection Closed");

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Connection Closed"));
  });

  it("keeps a partly delivered message instead of rejecting", async () => {
    const { connector, sendMessage } = connectedConnector();
    sendMessage
      .mockResolvedValueOnce({ key: { id: "W1" } })
      .mockRejectedValue(new Error("Connection Closed"));

    // A rejection would make the caller resend the chunk that already landed.
    await expect(connector.replyMessage({ channel: JID }, "A".repeat(5000))).resolves.toBe("W1");

    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
