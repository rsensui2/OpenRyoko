import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureLogger, logger } from "../logger.js";
import { LOGS_DIR } from "../paths.js";

// `ryoko start` sets the logger up before the gateway does, so that what is logged
// while the home is prepared reaches logs/gateway.log too. The gateway then sets it up
// again, the same way. That second time must not disturb what is already being written.

const LOG = path.join(LOGS_DIR, "gateway.log");

/** The lines in the log file once the logger has let go of it and `expected` of them are there. */
async function written(expected: number): Promise<string[]> {
  configureLogger({ file: false });
  let lines: string[] = [];
  await vi.waitFor(() => {
    lines = fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(expected);
  });
  return lines;
}

describe("configureLogger, called again for the same log file", () => {
  beforeEach(() => {
    fs.rmSync(LOG, { force: true });
  });

  afterEach(() => {
    configureLogger({ level: "info", stdout: true, file: false });
  });

  it("keeps everything in the order it was logged", async () => {
    // Closing the file and opening it again lets the next line overtake the ones
    // before it: often, not always. Many rounds, so that once is enough to notice.
    for (let round = 0; round < 60; round++) {
      fs.rmSync(LOG, { force: true });
      configureLogger({ level: "info", stdout: false, file: true });
      for (let line = 1; line <= 3; line++) logger.info(`before the second set-up, line ${line}`);
      configureLogger({ level: "info", stdout: false, file: true });
      logger.info("after the second set-up");

      const lines = await written(4);
      expect(lines.map((line) => line.replace(/^\S+ \[INFO\] /, "")), `round ${round}`).toEqual([
        "before the second set-up, line 1",
        "before the second set-up, line 2",
        "before the second set-up, line 3",
        "after the second set-up",
      ]);
    }
  });

  it("still takes the level and the standard output setting it is given", async () => {
    const shown = vi.spyOn(console, "log").mockImplementation(() => {});
    configureLogger({ level: "info", stdout: false, file: true });
    logger.debug("not logged at info");
    logger.info("logged to the file alone");
    configureLogger({ level: "debug", stdout: true, file: true });
    logger.debug("logged at debug, to both");

    const lines = await written(2);
    expect(lines[0]).toMatch(/\[INFO\] logged to the file alone$/);
    expect(lines[1]).toMatch(/\[DEBUG\] logged at debug, to both$/);
    expect(shown.mock.calls.map((call) => String(call[0]))).toEqual([expect.stringMatching(/\[DEBUG\] logged at debug, to both$/)]);
    shown.mockRestore();
  });

  it("opens the file again once it has been told to stop writing to it", async () => {
    configureLogger({ level: "info", stdout: false, file: true });
    logger.info("first");
    configureLogger({ file: false });
    logger.info("while the file is off");
    configureLogger({ level: "info", stdout: false, file: true });
    logger.info("second");

    const lines = await written(2);
    expect(lines.map((line) => line.replace(/^\S+ \[INFO\] /, ""))).toEqual(["first", "second"]);
  });
});
