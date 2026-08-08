/**
 * A second scripted fake MCP server for the multi-downstream tests,
 * parameterised by environment so one file can stand in for any number
 * of distinct servers:
 *
 *   FAKE_MULTI_NAME   server name reported in initialize and echoes
 *   FAKE_MULTI_TOOLS  comma-separated tool names to advertise
 *   FAKE_MULTI_DIE    exit without replying when this tool is called
 *
 * Every tool echoes {server, tool, args} so a test can prove which
 * child actually received a call.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { createInterface } from "node:readline";

const NAME = process.env.FAKE_MULTI_NAME ?? "fake-multi";
const TOOL_NAMES = (process.env.FAKE_MULTI_TOOLS ?? "alpha")
  .split(",")
  .map((t) => t.trim())
  .filter((t) => t.length > 0);
const DIE_TOOL = process.env.FAKE_MULTI_DIE;

function write(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const TOOLS = TOOL_NAMES.map((name) => ({
  name,
  description: `${name} on ${NAME}`,
  inputSchema: { type: "object", properties: {} }
}));

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (line.trim().length === 0) return;
  let message: { id?: number; method: string; params?: Record<string, unknown> };
  try {
    message = JSON.parse(line) as typeof message;
  } catch {
    return;
  }
  const id = message.id;
  switch (message.method) {
    case "initialize":
      write({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: (message.params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: {}, ...(NAME === "res" ? { resources: {} } : {}) },
          serverInfo: { name: NAME, version: "0.0.1" },
          instructions: `Instructions from ${NAME}.`
        }
      });
      return;
    case "notifications/initialized":
      return;
    case "ping":
      write({ jsonrpc: "2.0", id, result: {} });
      return;
    case "tools/list":
      write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    case "resources/list":
      write({ jsonrpc: "2.0", id, result: { resources: [{ uri: `mem://${NAME}` }] } });
      return;
    case "tools/call": {
      const name = message.params?.name as string;
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      if (DIE_TOOL !== undefined && name === DIE_TOOL) {
        process.exit(9);
      }
      if (!TOOL_NAMES.includes(name)) {
        write({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
        return;
      }
      write({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ server: NAME, tool: name, args }) }],
          isError: false
        }
      });
      return;
    }
    default:
      if (id !== undefined) {
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Method not found: ${message.method}` }
        });
      }
  }
});
