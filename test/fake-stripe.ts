/**
 * Scripted fake of Stripe's MCP server for the secure-stripe preset
 * tests: newline-delimited JSON-RPC 2.0 over stdio, a subset of the
 * real @stripe/mcp@0.2.5 tool names, and the same startup behaviour
 * that matters to the gate: WITHOUT a STRIPE_SECRET_KEY in its
 * environment it prints an error and exits non-zero before answering
 * the MCP handshake, exactly like the real server refusing to run
 * keyless. That lets the preset's --check fail-closed path be tested
 * without touching the network.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import { createInterface } from "node:readline";

if (process.env.STRIPE_SECRET_KEY === undefined || process.env.STRIPE_SECRET_KEY.length === 0) {
  process.stderr.write("You did not provide an API key. Set STRIPE_SECRET_KEY.\n");
  process.exit(1);
}

function write(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + "\n");
}

/** Real tool names from the @stripe/mcp@0.2.5 --tools=all catalog. */
const TOOLS = [
  {
    name: "create_refund",
    description: "Refund a payment intent.",
    inputSchema: {
      type: "object",
      properties: {
        payment_intent: { type: "string" },
        amount: { type: "number" },
        reason: { type: "string" }
      },
      required: ["payment_intent"]
    }
  },
  {
    name: "create_payment_link",
    description: "Create a payment link.",
    inputSchema: {
      type: "object",
      properties: { price: { type: "string" }, quantity: { type: "number" } },
      required: ["price", "quantity"]
    }
  },
  {
    name: "list_customers",
    description: "List customers (read-only).",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } }
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
          serverInfo: { name: "fake-stripe", version: "0.2.5" }
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
      write({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ tool: name, ok: true }) }],
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
