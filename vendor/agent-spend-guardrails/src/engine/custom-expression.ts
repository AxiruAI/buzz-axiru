/**
 * Sandboxed evaluator for `CustomExpressionRule` (T-017).
 *
 * Spec reference: Cross-Rail Governance Engineering Spec v1.0 §5.4.
 *
 * The custom expression language is a STRICT SUBSET of JavaScript
 * boolean expressions, designed so that:
 *
 *   1. Every well-formed expression returns a boolean. The matcher
 *      treats the expression result directly as `RuleEvaluation.matched`.
 *   2. The evaluator is DETERMINISTIC. No `Date.now()`, no `Math.random()`,
 *      no I/O, no access to any host object. The only inputs visible
 *      to user code are fields on the `ovt` namespace.
 *   3. The evaluator is BUDGETED. Every parse/eval step decrements a
 *      step counter; running out of budget surfaces a typed error that
 *      the dispatcher escalates to `axiru.deny.expression_timeout`.
 *
 * Why a hand-rolled parser instead of `acorn` / `Function()` / `eval`:
 *
 *   Calling `new Function("return " + expr)` would execute arbitrary
 *   user JavaScript with full access to the global scope (globalThis,
 *   process, fetch). Even with `Object.freeze(globalThis)` workarounds,
 *   the attack surface is too wide for a financial-policy evaluator.
 *
 *   Acorn-with-walker would be safer but still requires us to AST-walk
 *   every expression for forbidden constructs at parse time, and we'd
 *   still ship the whole acorn dependency into the bundle. A
 *   ~300-line hand-rolled recursive-descent parser is simpler, has
 *   zero deps, and the grammar is small enough that it audits in
 *   one sitting.
 *
 * Grammar (LL(1), highest precedence last):
 *
 *   expression  := or
 *   or          := and ("||" and)*
 *   and         := not ("&&" not)*
 *   not         := "!" not | comparison
 *   comparison  := primary (CMP_OP primary | "in" listLiteral)?
 *   primary     := literal | path | "(" expression ")"
 *   listLiteral := "[" (literal ("," literal)*)? "]"
 *   literal     := number | string | boolean | "null"
 *   path        := IDENT ("." IDENT | "[" string "]")*
 *   CMP_OP      := "==" | "!=" | ">" | ">=" | "<" | "<="
 *
 * Path semantics: only `ovt` and `now` are accessible at the root.
 * `now` resolves to `context.now.getTime()` (epoch milliseconds) so
 * arithmetic comparisons against numeric literals work. `ovt.*`
 * traversal is by property name; bigint fields (e.g.
 * `ovt.amount.minor_units`) are coerced to a JS bigint at the leaf,
 * and comparisons against numeric literals widen the literal to bigint.
 *
 * Purity invariant: this file is pure. The step-counter approach
 * means no `performance.now()` reads; budget is measured in AST
 * operations, not wall-clock. A budget of 10_000 steps corresponds
 * to ~1-2ms on a modern Node runtime — well inside the spec's 10ms
 * budget while still allowing reasonably complex expressions
 * (~50 boolean ops nested 5 deep).
 */

import type { CustomExpressionRule, OutboundValueTransfer } from "../types/index.js";
import type { EvalContext, RuleEvaluation } from "./types.js";

/* ------------------------------------------------------------------ */
/* Public entry                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_STEP_BUDGET = 10_000;

export function evaluateCustomExpressionRule(
  rule: CustomExpressionRule,
  ovt: OutboundValueTransfer,
  context: EvalContext
): RuleEvaluation {
  let ast: Expr;
  try {
    ast = parse(rule.expression);
  } catch (err) {
    return {
      matched: false,
      error: `CustomExpressionRule parse failed: ${(err as Error).message}`
    };
  }

  const budget: Budget = { remaining: DEFAULT_STEP_BUDGET };
  try {
    const result = evalExpr(ast, { ovt, now: context.now.getTime() }, budget);
    if (typeof result !== "boolean") {
      return {
        matched: false,
        error: `CustomExpressionRule must evaluate to boolean, got ${typeof result} (${describe(result)})`
      };
    }
    return { matched: result };
  } catch (err) {
    return {
      matched: false,
      error: `CustomExpressionRule eval failed: ${(err as Error).message}`
    };
  }
}

/* ------------------------------------------------------------------ */
/* AST                                                                */
/* ------------------------------------------------------------------ */

type Expr =
  | { kind: "literal"; value: string | number | boolean | null }
  | { kind: "path"; segments: string[] }
  | { kind: "not"; operand: Expr }
  | { kind: "binary"; op: BinaryOp; left: Expr; right: Expr }
  | { kind: "in"; left: Expr; list: (string | number | boolean | null)[] };

type BinaryOp = "||" | "&&" | "==" | "!=" | ">" | ">=" | "<" | "<=";

/* ------------------------------------------------------------------ */
/* Tokenizer                                                          */
/* ------------------------------------------------------------------ */

type Token =
  | { type: "number"; value: number }
  | { type: "string"; value: string }
  | { type: "ident"; value: string }
  | { type: "punct"; value: string }
  | { type: "eof" };

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const len = source.length;

  while (i < len) {
    const ch = source.charCodeAt(i);
    // Whitespace
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
      i++;
      continue;
    }

    // String literal: "..." or '...'
    if (ch === 34 /* " */ || ch === 39 /* ' */) {
      const quote = ch;
      i++;
      let s = "";
      while (i < len && source.charCodeAt(i) !== quote) {
        if (source.charCodeAt(i) === 92 /* \ */ && i + 1 < len) {
          const next = source[i + 1];
          if (next === "n") s += "\n";
          else if (next === "t") s += "\t";
          else if (next === "\\") s += "\\";
          else if (next === '"') s += '"';
          else if (next === "'") s += "'";
          else throw new Error(`Unknown escape \\${next} at offset ${i}`);
          i += 2;
        } else {
          s += source[i];
          i++;
        }
      }
      if (i >= len) throw new Error("Unterminated string literal");
      i++; // consume closing quote
      tokens.push({ type: "string", value: s });
      continue;
    }

    // Number literal
    if ((ch >= 48 && ch <= 57) || (ch === 45 && isStartOfNumber(tokens))) {
      let s = "";
      if (ch === 45) {
        s += "-";
        i++;
      }
      while (i < len) {
        const c = source.charCodeAt(i);
        if ((c >= 48 && c <= 57) || c === 46 /* . */) {
          s += source[i];
          i++;
        } else break;
      }
      const n = Number(s);
      if (!Number.isFinite(n)) throw new Error(`Invalid number literal "${s}"`);
      tokens.push({ type: "number", value: n });
      continue;
    }

    // Identifier / keyword
    if (isIdentStart(ch)) {
      let s = "";
      while (i < len) {
        const c = source.charCodeAt(i);
        if (isIdentCont(c)) {
          s += source[i];
          i++;
        } else break;
      }
      tokens.push({ type: "ident", value: s });
      continue;
    }

    // Punctuation — try 2-char operators first
    const two = source.slice(i, i + 2);
    if (two === "==" || two === "!=" || two === ">=" || two === "<=" || two === "&&" || two === "||") {
      tokens.push({ type: "punct", value: two });
      i += 2;
      continue;
    }
    const one = source[i];
    if ("()[],.!<>".indexOf(one) >= 0) {
      tokens.push({ type: "punct", value: one });
      i++;
      continue;
    }

    throw new Error(`Unexpected character "${source[i]}" at offset ${i}`);
  }

  tokens.push({ type: "eof" });
  return tokens;
}

function isStartOfNumber(prev: Token[]): boolean {
  // A leading minus is the start of a number literal only when the
  // previous token would not allow a binary operator at this position
  // (i.e. after an open paren, comma, or another operator). For the
  // tiny grammar we support, this catches the common case
  // `< -100`. Simpler heuristic: previous token is missing OR is
  // a punctuation that is not `)` or `]`.
  if (prev.length === 0) return true;
  const last = prev[prev.length - 1];
  if (last.type !== "punct") return false;
  return last.value !== ")" && last.value !== "]";
}

function isIdentStart(ch: number): boolean {
  return (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95 /* _ */;
}
function isIdentCont(ch: number): boolean {
  return isIdentStart(ch) || (ch >= 48 && ch <= 57);
}

/* ------------------------------------------------------------------ */
/* Parser (recursive descent)                                         */
/* ------------------------------------------------------------------ */

interface ParserState {
  tokens: Token[];
  pos: number;
}

function parse(source: string): Expr {
  if (typeof source !== "string" || source.trim().length === 0) {
    throw new Error("expression is empty");
  }
  if (source.length > 4096) {
    throw new Error(`expression exceeds 4096-char limit (got ${source.length})`);
  }
  const tokens = tokenize(source);
  const state: ParserState = { tokens, pos: 0 };
  const expr = parseExpression(state);
  if (peek(state).type !== "eof") {
    throw new Error(`Unexpected trailing token: ${JSON.stringify(peek(state))}`);
  }
  return expr;
}

function peek(state: ParserState): Token {
  return state.tokens[state.pos];
}
function consume(state: ParserState): Token {
  return state.tokens[state.pos++];
}
function consumePunct(state: ParserState, value: string): void {
  const t = peek(state);
  if (t.type !== "punct" || t.value !== value) {
    throw new Error(`Expected "${value}", got ${JSON.stringify(t)}`);
  }
  state.pos++;
}

function parseExpression(state: ParserState): Expr {
  return parseOr(state);
}

function isPunct(t: Token, value: string): boolean {
  return t.type === "punct" && t.value === value;
}

function parseOr(state: ParserState): Expr {
  let left = parseAnd(state);
  while (isPunct(peek(state), "||")) {
    consume(state);
    const right = parseAnd(state);
    left = { kind: "binary", op: "||", left, right };
  }
  return left;
}

function parseAnd(state: ParserState): Expr {
  let left = parseNot(state);
  while (isPunct(peek(state), "&&")) {
    consume(state);
    const right = parseNot(state);
    left = { kind: "binary", op: "&&", left, right };
  }
  return left;
}

function parseNot(state: ParserState): Expr {
  if (isPunct(peek(state), "!")) {
    consume(state);
    return { kind: "not", operand: parseNot(state) };
  }
  return parseComparison(state);
}

function parseComparison(state: ParserState): Expr {
  const left = parsePrimary(state);
  const next = peek(state);
  if (next.type === "punct" && (next.value === "==" || next.value === "!=" || next.value === ">" || next.value === ">=" || next.value === "<" || next.value === "<=")) {
    consume(state);
    const right = parsePrimary(state);
    return { kind: "binary", op: next.value as BinaryOp, left, right };
  }
  if (next.type === "ident" && next.value === "in") {
    consume(state);
    consumePunct(state, "[");
    const list: (string | number | boolean | null)[] = [];
    if (!isPunct(peek(state), "]")) {
      list.push(parseLiteralValue(state));
      while (isPunct(peek(state), ",")) {
        consume(state);
        list.push(parseLiteralValue(state));
      }
    }
    consumePunct(state, "]");
    return { kind: "in", left, list };
  }
  return left;
}

function parsePrimary(state: ParserState): Expr {
  const t = peek(state);
  if (t.type === "punct" && t.value === "(") {
    consume(state);
    const inner = parseExpression(state);
    consumePunct(state, ")");
    return inner;
  }
  if (t.type === "number" || t.type === "string") {
    consume(state);
    return { kind: "literal", value: t.value };
  }
  if (t.type === "ident") {
    if (t.value === "true" || t.value === "false") {
      consume(state);
      return { kind: "literal", value: t.value === "true" };
    }
    if (t.value === "null") {
      consume(state);
      return { kind: "literal", value: null };
    }
    return parsePath(state);
  }
  throw new Error(`Unexpected token in primary: ${JSON.stringify(t)}`);
}

function parsePath(state: ParserState): Expr {
  const first = consume(state);
  if (first.type !== "ident") throw new Error("Internal: parsePath called without ident");
  const segments: string[] = [first.value];
  while (true) {
    const next = peek(state);
    if (isPunct(next, ".")) {
      consume(state);
      const seg = consume(state);
      if (seg.type !== "ident") throw new Error(`Expected identifier after ".", got ${JSON.stringify(seg)}`);
      segments.push(seg.value);
    } else if (isPunct(next, "[")) {
      consume(state);
      const idx = consume(state);
      if (idx.type !== "string") throw new Error(`Bracket access requires a string literal, got ${JSON.stringify(idx)}`);
      consumePunct(state, "]");
      segments.push(idx.value);
    } else {
      break;
    }
  }
  return { kind: "path", segments };
}

function parseLiteralValue(state: ParserState): string | number | boolean | null {
  const t = consume(state);
  if (t.type === "number") return t.value;
  if (t.type === "string") return t.value;
  if (t.type === "ident") {
    if (t.value === "true") return true;
    if (t.value === "false") return false;
    if (t.value === "null") return null;
  }
  throw new Error(`Expected literal value, got ${JSON.stringify(t)}`);
}

/* ------------------------------------------------------------------ */
/* Evaluator                                                          */
/* ------------------------------------------------------------------ */

interface EvalEnv {
  ovt: OutboundValueTransfer;
  now: number;
}

interface Budget {
  remaining: number;
}

type LeafValue = string | number | bigint | boolean | null;

function evalExpr(expr: Expr, env: EvalEnv, budget: Budget): LeafValue {
  if (--budget.remaining <= 0) {
    throw new Error("step budget exhausted (>10ms equivalent)");
  }

  switch (expr.kind) {
    case "literal":
      return expr.value;
    case "not": {
      const v = evalExpr(expr.operand, env, budget);
      return !truthy(v);
    }
    case "binary":
      return evalBinary(expr.op, expr.left, expr.right, env, budget);
    case "in": {
      const left = evalExpr(expr.left, env, budget);
      for (const candidate of expr.list) {
        if (looseEquals(left, candidate)) return true;
      }
      return false;
    }
    case "path":
      return resolvePath(expr.segments, env);
  }
}

function evalBinary(op: BinaryOp, leftAst: Expr, rightAst: Expr, env: EvalEnv, budget: Budget): LeafValue {
  // Short-circuit logical ops.
  if (op === "||") {
    const lv = evalExpr(leftAst, env, budget);
    if (truthy(lv)) return true;
    return truthy(evalExpr(rightAst, env, budget));
  }
  if (op === "&&") {
    const lv = evalExpr(leftAst, env, budget);
    if (!truthy(lv)) return false;
    return truthy(evalExpr(rightAst, env, budget));
  }

  const left = evalExpr(leftAst, env, budget);
  const right = evalExpr(rightAst, env, budget);

  if (op === "==") return looseEquals(left, right);
  if (op === "!=") return !looseEquals(left, right);
  return compareOrdered(op, left, right);
}

function compareOrdered(op: ">" | ">=" | "<" | "<=", left: LeafValue, right: LeafValue): boolean {
  // Numeric / bigint comparison. We widen number → bigint when the
  // other side is bigint, but only if the number is a safe integer.
  if (typeof left === "bigint" || typeof right === "bigint") {
    const l = toBigIntForCompare(left);
    const r = toBigIntForCompare(right);
    if (op === ">") return l > r;
    if (op === ">=") return l >= r;
    if (op === "<") return l < r;
    return l <= r;
  }
  if (typeof left === "number" && typeof right === "number") {
    if (op === ">") return left > right;
    if (op === ">=") return left >= right;
    if (op === "<") return left < right;
    return left <= right;
  }
  // String comparison: lexicographic. Common for ISO country codes etc.
  if (typeof left === "string" && typeof right === "string") {
    if (op === ">") return left > right;
    if (op === ">=") return left >= right;
    if (op === "<") return left < right;
    return left <= right;
  }
  throw new Error(`Ordered comparison "${op}" requires same primitive types; got ${typeof left} and ${typeof right}`);
}

function toBigIntForCompare(v: LeafValue): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) {
      throw new Error(`Cannot compare non-integer number ${v} against bigint`);
    }
    return BigInt(v);
  }
  throw new Error(`Cannot widen ${typeof v} to bigint for comparison`);
}

function looseEquals(a: LeafValue, b: LeafValue): boolean {
  if (a === null || b === null) return a === b;
  if (typeof a === "bigint" || typeof b === "bigint") {
    try {
      return toBigIntForCompare(a) === toBigIntForCompare(b);
    } catch {
      return false;
    }
  }
  // Otherwise strict equality; we never coerce string<->number to avoid surprises.
  return a === b;
}

function truthy(v: LeafValue): boolean {
  if (typeof v === "boolean") return v;
  if (v === null) return false;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "bigint") return v !== 0n;
  if (typeof v === "string") return v.length > 0;
  return false;
}

/* ------------------------------------------------------------------ */
/* Path resolution                                                    */
/* ------------------------------------------------------------------ */

/**
 * Resolve a dot-separated path against the limited evaluation env.
 *
 * Only `ovt` and `now` are reachable. The root identifier is checked
 * here; any other root identifier (`process`, `globalThis`,
 * `constructor`, …) throws. This is the core sandboxing guarantee:
 * user expressions cannot reach the host environment.
 *
 * Within the `ovt` subtree, traversal follows ordinary property
 * access. Two protections:
 *   1. We use a manual `hasOwnProperty`-style check at each step;
 *      prototype properties (`__proto__`, `constructor`, `toString`)
 *      are NOT walkable.
 *   2. Functions, symbols, and host objects are never returned;
 *      anything that isn't a string/number/bigint/boolean/null at the
 *      leaf throws a typed error.
 */
function resolvePath(segments: string[], env: EvalEnv): LeafValue {
  const [root, ...rest] = segments;
  let current: unknown;
  if (root === "ovt") {
    current = env.ovt;
  } else if (root === "now") {
    if (rest.length > 0) {
      throw new Error("\"now\" is a scalar; field access is not allowed");
    }
    return env.now;
  } else {
    throw new Error(`Unknown root identifier "${root}" (only "ovt" and "now" are in scope)`);
  }

  for (const seg of rest) {
    if (current === null || current === undefined) {
      throw new Error(`Cannot read property "${seg}" on ${current === null ? "null" : "undefined"}`);
    }
    if (typeof current !== "object") {
      throw new Error(`Cannot read property "${seg}" on primitive value`);
    }
    // Own-property check guards against prototype pollution.
    if (!Object.prototype.hasOwnProperty.call(current, seg)) {
      // Reading a missing property returns null rather than throwing —
      // policies often check optional fields (e.g.
      // `ovt.counterparty.display.country_code`) and we don't want a
      // missing key to crash the whole expression. The user can still
      // explicitly check `!= null`.
      return null;
    }
    current = (current as Record<string, unknown>)[seg];
  }

  return coerceLeaf(current, segments);
}

function coerceLeaf(value: unknown, segments: string[]): LeafValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value;
  // Date → epoch millis (matches `now` semantics).
  if (value instanceof Date) return value.getTime();
  // Everything else (objects, arrays, functions, symbols) is opaque.
  throw new Error(`Path "${segments.join(".")}" did not resolve to a scalar (got ${describe(value)})`);
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array(len=${v.length})`;
  if (typeof v === "object") return "object";
  return typeof v;
}
