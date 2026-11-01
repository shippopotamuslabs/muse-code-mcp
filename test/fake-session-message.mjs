#!/usr/bin/env node
// Stand-in for `muse session-message`. Modes: default (list = closed ingress,
// send = accepted JSON) and MUSE_FAKE_MESSAGE=crash (non-JSON, exit 1).
import { writeFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");
const argv = process.argv.slice(2);

if (process.env.MUSE_FAKE_MESSAGE_LOG) {
  writeFileSync(process.env.MUSE_FAKE_MESSAGE_LOG, JSON.stringify({ argv, stdin }));
}

if (process.env.MUSE_FAKE_MESSAGE === "crash") {
  process.stdout.write("not-json");
  process.stderr.write("boom\n");
  process.exit(1);
}

if (argv.includes("list")) {
  process.stdout.write(
    JSON.stringify({
      schema_version: 1,
      status: "unavailable",
      error_code: "external_agent_ingress_closed",
    }),
  );
  process.stderr.write("external agent ingress is unavailable\n");
  process.exit(1);
}

process.stdout.write(JSON.stringify({ schema_version: 1, status: "accepted" }));
process.exit(0);
