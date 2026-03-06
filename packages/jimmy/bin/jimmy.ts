#!/usr/bin/env node
import { Command } from "commander";
import { runSetup } from "../src/cli/setup.js";
import { runStart } from "../src/cli/start.js";
import { runStop } from "../src/cli/stop.js";
import { runStatus } from "../src/cli/status.js";

const program = new Command();
program
  .name("jimmy")
  .description("Lightweight AI gateway daemon")
  .version("0.1.0");

program
  .command("setup")
  .description("Initialize Jimmy and install dependencies")
  .action(async () => {
    await runSetup();
  });

program
  .command("start")
  .description("Start the gateway daemon")
  .option("--daemon", "Run in background")
  .action(async (opts) => {
    await runStart(opts);
  });

program
  .command("stop")
  .description("Stop the gateway daemon")
  .action(async () => {
    await runStop();
  });

program
  .command("status")
  .description("Show gateway status")
  .action(async () => {
    await runStatus();
  });

program.parse();
