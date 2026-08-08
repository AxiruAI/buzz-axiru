/**
 * MCP server: plain JSON-RPC 2.0 over stdio, newline-delimited.
 *
 * VERIFIED (block/buzz, crates/buzz-acp/README.md): buzz-acp accepts
 * BUZZ_ACP_MCP_COMMAND, "path to an optional MCP server binary to
 * provide to the agent subprocess", and ACP session/new carries
 * mcpServers to the agent. Point BUZZ_ACP_MCP_COMMAND at the
 * buzz-axiru binary and every harnessed agent (Goose, Codex, Claude
 * Code) sees the request_spend_approval tool.
 *
 * ASSUMPTION: buzz-acp passes no arguments to that binary, so the
 * default CLI action (no args) starts this stdio server.
 *
 * No SDK dependency: the surface is small enough that the raw
 * protocol shapes are clearer than a framework.
 *
 * Licensed under the Apache License, Version 2.0.
 */

import type { Bridge } from "./guard.js";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
export const LATEST_PROTOCOL_VERSION = "2025-06-18";

export const TOOL_NAME = "request_spend_approval";

export const TOOL_DEFINITION = {
  name: TOOL_NAME,
  description:
    "Request authorization BEFORE moving any money. Returns allow, require_approval, or deny " +
    "with stable reason codes. On require_approval a human is notified in the Buzz channel; " +
    "hold execution and call this tool again with identical arguments after they decide. " +
    "Every decision is written to a tamper-evident local ledger keyed to your Nostr pubkey.",
  inputSchema: {
    type: "object",
    properties: {
      amount_minor_units: {
        type: "string",
        pattern: "^[0-9]+$",
        description:
          "Amount as a base-10 integer string in minor units (cents for USD: \"4000000\" is USD 40,000.00). A string, never a number."
      },
      currency: {
        type: "string",
        description: "ISO 4217 code or token symbol, e.g. \"USD\", \"USDC\"."
      },
      counterparty: {
        type: "string",
        description: "Stable counterparty id being paid (merchant id, vendor slug, wallet address)."
      },
      memo: {
        type: "string",
        description: "One line for the human approver: what this payment is for."
      },
      agent_pubkey: {
        type: "string",
        description: "Your Nostr public key as 64-char lowercase hex (the identity your Buzz events are signed with)."
      }
    },
    required: ["amount_minor_units", "currency", "counterparty", "memo", "agent_pubkey"]
  }
} as const;

/**
 * Longest single JSON-RPC line accepted from the agent, in UTF-16 code
 * units. The agent is untrusted and speaks over a pipe with no framing
 * of its own, so without a cap it can make the bridge buffer an
 * unbounded string just by never sending a newline.
 */
export const MAX_LINE_CHARS = 1_048_576;

/**
 * Structural limits on any argument object the bridge will process.
 * Both the canonical-JSON fingerprint and the guardrails evaluator walk
 * these structures recursively: measured, a 20k-deep object throws
 * RangeError out of sha256Fingerprint, which kills the gate process.
 * Rejecting the shape up front is cheaper than surviving the crash.
 */
export const MAX_ARGUMENT_DEPTH = 64;
export const MAX_ARGUMENT_NODES = 20_000;

/**
 * Describe why a value is too big or too deep to process, or null when
 * it is fine. Iterative on purpose: a recursive checker would hit the
 * same stack limit it exists to detect.
 */
export function jsonShapeProblem(
  value: unknown,
  maxDepth: number = MAX_ARGUMENT_DEPTH,
  maxNodes: number = MAX_ARGUMENT_NODES
): string | null {
  const stack: Array<{ node: unknown; depth: number }> = [{ node: value, depth: 1 }];
  let nodes = 0;
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes) {
      return `arguments contain more than ${maxNodes} values`;
    }
    if (depth > maxDepth) {
      return `arguments are nested deeper than ${maxDepth} levels`;
    }
    if (Array.isArray(node)) {
      for (const child of node) stack.push({ node: child, depth: depth + 1 });
    } else if (typeof node === "object" && node !== null) {
      for (const child of Object.values(node as Record<string, unknown>)) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return null;
}

/**
 * Read newline-delimited JSON-RPC with a hard cap on line length.
 * readline was doing this before and has no such cap; an oversized
 * line is answered with a protocol error and skipped rather than
 * buffered.
 */
export async function serveNdjson(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  handle: (line: string) => Promise<string | null>
): Promise<void> {
  const oversize = (): string =>
    errorResponse(null, -32600, `Request line exceeds the ${MAX_LINE_CHARS} character limit and was discarded`);
  let buffer = "";
  let discarding = false;
  input.setEncoding("utf8");
  for await (const chunk of input as AsyncIterable<string>) {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (discarding) {
        // The tail of a line we already refused; answer once, move on.
        discarding = false;
        output.write(oversize() + "\n");
        continue;
      }
      if (line.trim().length === 0) continue;
      const reply = await handle(line);
      if (reply !== null) output.write(reply + "\n");
    }
    if (buffer.length > MAX_LINE_CHARS) {
      buffer = "";
      discarding = true;
    }
  }
  if (discarding) output.write(oversize() + "\n");
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

type Json = Record<string, unknown>;

export function response(id: number | string | null, result: Json): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}

export function errorResponse(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

export class McpServer {
  constructor(
    private readonly bridge: Bridge,
    private readonly version: string
  ) {}

  /** Handle one JSON-RPC message. Returns the serialized response, or null for notifications. */
  async handleMessage(raw: string): Promise<string | null> {
    try {
      return await this.dispatch(raw);
    } catch (err) {
      // Nothing an agent sends may take the bridge down: an unhandled
      // rejection here would propagate out of the serve loop and end
      // the process, which is a denial of service the agent controls.
      return errorResponse(null, -32603, `Internal error: ${(err as Error).message}`);
    }
  }

  private async dispatch(raw: string): Promise<string | null> {
    let message: JsonRpcRequest;
    try {
      message = JSON.parse(raw) as JsonRpcRequest;
    } catch {
      return errorResponse(null, -32700, "Parse error: not valid JSON");
    }
    const id = message.id ?? null;
    const isNotification = message.id === undefined;

    switch (message.method) {
      case "initialize": {
        const requested = (message.params?.protocolVersion as string) ?? "";
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : LATEST_PROTOCOL_VERSION;
        return response(id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "buzz-axiru", version: this.version },
          instructions:
            "Call request_spend_approval before any payment. Respect its decision: " +
            "allow means proceed once, require_approval means hold for a human, deny means stop."
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return response(id, {});
      case "tools/list":
        return response(id, { tools: [TOOL_DEFINITION] });
      case "tools/call": {
        const name = message.params?.name;
        if (name !== TOOL_NAME) {
          return errorResponse(id, -32602, `Unknown tool: ${String(name)}`);
        }
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        const problem = jsonShapeProblem(args);
        if (problem !== null) {
          return errorResponse(id, -32602, `tools/call rejected: ${problem}`);
        }
        try {
          const decision = await this.bridge.evaluate({
            amount_minor_units: String(args.amount_minor_units ?? ""),
            currency: String(args.currency ?? ""),
            counterparty: String(args.counterparty ?? ""),
            memo: String(args.memo ?? ""),
            agent_pubkey: String(args.agent_pubkey ?? "")
          });
          return response(id, {
            content: [{ type: "text", text: JSON.stringify(decision, null, 2) }],
            isError: false
          });
        } catch (err) {
          return response(id, {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: (err as Error).message }, null, 2)
              }
            ],
            isError: true
          });
        }
      }
      default:
        if (isNotification) return null;
        return errorResponse(id, -32601, `Method not found: ${message.method}`);
    }
  }

  /** Serve newline-delimited JSON-RPC on stdin/stdout until stdin closes. */
  async serveStdio(): Promise<void> {
    await serveNdjson(process.stdin, process.stdout, (line) => this.handleMessage(line));
  }
}
