/**
 * Scripted fake downstream payment MCP server for tests: newline-
 * delimited JSON-RPC 2.0 over stdio, three tools, and a call log
 * written to the file named by FAKE_DOWNSTREAM_LOG so tests can
 * assert exactly which calls reached the downstream side.
 *
 *   create_payment {amount, currency, destination}  -> {paid: true, ...}
 *   get_weather {city}                              -> plain text
 *   crash_now {}                                    -> exits without replying
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const LOG_PATH = process.env.FAKE_DOWNSTREAM_LOG;
let paymentCounter = 0;

function logCall(name: string, args: unknown): void {
  if (LOG_PATH === undefined) return;
  appendFileSync(LOG_PATH, JSON.stringify({ name, args }) + "\n", "utf8");
}

function write(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

const TOOLS = [
  {
    name: "create_payment",
    description: "Send a payment.",
    inputSchema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "minor units" },
        currency: { type: "string" },
        destination: { type: "string" }
      },
      required: ["amount", "currency", "destination"]
    }
  },
  {
    name: "get_weather",
    description: "Weather lookup, plainly not a payment.",
    inputSchema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"]
    }
  },
  {
    name: "crash_now",
    description: "Simulates a downstream crash: exits without replying.",
    inputSchema: { type: "object", properties: {} }
  }
];

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
          capabilities: { tools: {} },
          serverInfo: { name: "fake-payments", version: "0.0.1" },
          instructions: "Fake payment rail for tests."
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
    case "tools/call": {
      const name = message.params?.name as string;
      const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "crash_now") {
        process.exit(7);
      }
      if (name === "create_payment") {
        logCall(name, args);
        paymentCounter += 1;
        write({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  paid: true,
                  payment_id: `pay_${paymentCounter}`,
                  amount: args.amount,
                  currency: args.currency,
                  destination: args.destination
                })
              }
            ],
            isError: false
          }
        });
        return;
      }
      if (name === "get_weather") {
        logCall(name, args);
        write({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `sunny in ${String(args.city)}` }],
            isError: false
          }
        });
        return;
      }
      write({
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${name}` }
      });
      return;
    }
    default:
      if (id !== undefined) {
        write({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      }
  }
});
