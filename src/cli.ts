#!/usr/bin/env -S npx tsx
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assemble } from "./core/assemble.js";
import { run } from "./core/run.js";
import { formatResult, formatMemory, formatPortLog, hex } from "./core/format.js";
import type { RegisterValues, DumpRange, AssemblerId } from "./core/types.js";

interface CliArgs {
  file?: string;
  registers: RegisterValues;
  dumps: DumpRange[];
  /** Ports to log OUT writes for; [] = all. undefined = don't show port log. */
  ports?: number[];
  entry?: number;
  sp?: number;
  maxInstructions?: number;
  loops?: number;
  listing: boolean;
  assembler: AssemblerId;
  help: boolean;
}

const REG_NAMES = new Set([
  "af", "bc", "de", "hl", "ix", "iy", "sp", "pc",
  "a", "b", "c", "d", "e", "h", "l",
]);

function parseNumber(text: string): number {
  const t = text.trim().toLowerCase();
  const n = t.startsWith("0x")
    ? parseInt(t.slice(2), 16)
    : t.startsWith("$")
      ? parseInt(t.slice(1), 16)
      : Number(t);
  if (Number.isNaN(n)) throw new Error(`Not a number: "${text}"`);
  return n;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { registers: {}, dumps: [], listing: false, assembler: "z80asm", help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "-h":
      case "--help":
        args.help = true;
        break;
      case "--reg": {
        const spec = argv[++i] ?? "";
        const [name, val] = spec.split("=");
        const key = name?.trim().toLowerCase();
        if (!key || !REG_NAMES.has(key) || val === undefined) {
          throw new Error(`Bad --reg "${spec}". Use e.g. --reg b=6 or --reg hl=0x1234`);
        }
        (args.registers as Record<string, number>)[key] = parseNumber(val);
        break;
      }
      case "--dump": {
        const spec = argv[++i] ?? "";
        const [startStr, lenStr] = spec.split(":");
        args.dumps.push({
          start: parseNumber(startStr),
          length: lenStr ? parseNumber(lenStr) : 16,
        });
        break;
      }
      case "--port": {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("-")) {
          args.ports = []; // bare --port = log every port
        } else {
          i++;
          const spec = next.trim();
          args.ports =
            spec.toLowerCase() === "all" || spec === "*"
              ? []
              : spec.split(",").map((p) => parseNumber(p) & 0xff);
        }
        break;
      }
      case "--entry":
        args.entry = parseNumber(argv[++i] ?? "");
        break;
      case "--sp":
        args.sp = parseNumber(argv[++i] ?? "");
        break;
      case "--max":
        args.maxInstructions = parseNumber(argv[++i] ?? "");
        break;
      case "--loops":
        args.loops = parseNumber(argv[++i] ?? "");
        break;
      case "--listing":
        args.listing = true;
        break;
      case "--assembler": {
        const v = (argv[++i] ?? "").trim().toLowerCase();
        if (v !== "z80asm" && v !== "wla") {
          throw new Error(`Bad --assembler "${v}". Use "z80asm" or "wla".`);
        }
        args.assembler = v;
        break;
      }
      default:
        if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        args.file = a;
    }
  }
  return args;
}

const HELP = `z80test — assemble a Z80 source file, run it, and inspect the result.

Usage:
  npm run cli -- <file.asm> [options]

Options:
  --reg <name>=<value>   Seed a register before running (hex with 0x or $).
                         Names: af bc de hl ix iy sp pc a b c d e h l
  --dump <start>[:<len>] Hex-dump a memory range after running (len default 16).
  --port [<p>[,<p>...]]  Log OUT writes and print them as a per-port byte stream.
                         No value (or "all") logs every port; or list ports e.g.
                         --port 0xFE,0xFF
  --entry <addr>         Override the entry point (PC).
  --sp <addr>            Set the stack pointer (default 0xFF00).
  --max <n>              Instruction cap before giving up (default 5,000,000).
  --loops <n>            Call the function <n> times in a row (default 1). Registers
                         are seeded only before the first call; later calls reuse the
                         register (incl. SP) and memory state left by the previous one.
  --listing              Print the assembled listing (address + bytes per line).
  --assembler <name>     Assembler backend: "z80asm" (default, in-process) or
                         "wla" (external WLA-DX; needs wla-z80 + wlalink on PATH).
  -h, --help             Show this help.

The runner pushes a sentinel return address, so a final RET in your code
stops execution cleanly ("function returned").

Example:
  npm run cli -- examples/multiply.asm --reg b=6 --reg c=7 --dump 0x9000:2`;

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`Error: ${(e as Error).message}\n`);
    console.error(HELP);
    process.exit(2);
  }

  if (args.help || !args.file) {
    console.log(HELP);
    process.exit(args.file ? 0 : 1);
  }

  const path = resolve(args.file);
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    console.error(`Error: cannot read file "${args.file}"`);
    process.exit(1);
  }

  const assembled = assemble(source, { assembler: args.assembler });

  if (args.listing) {
    console.log("Listing:");
    for (const l of assembled.listing) {
      const bytes = l.binary.map((b) => hex(b, 2)).join(" ");
      const ln = (l.lineNumber ?? 0).toString().padStart(4);
      console.log(`  ${ln}  ${hex(l.address, 4)}  ${bytes.padEnd(12)}  ${l.text}`);
    }
    console.log("");
  }

  if (!assembled.ok) {
    console.error("Assembly failed:");
    for (const err of assembled.errors) {
      console.error(`  line ${err.lineNumber ?? "?"}: ${err.message}`);
    }
    process.exit(1);
  }

  console.log(
    `Assembled ${assembled.bytes.size} bytes. Entry point: ${hex(assembled.entryPoint ?? 0, 4)}\n`,
  );

  const result = run(assembled, {
    registers: args.registers,
    entryPoint: args.entry,
    stackPointer: args.sp,
    maxInstructions: args.maxInstructions,
    loops: args.loops,
    logPorts: args.ports,
  });

  console.log(formatResult(result));
  for (const dump of args.dumps) {
    console.log("");
    console.log(formatMemory(result.memory, dump));
  }
  if (args.ports !== undefined) {
    console.log("");
    console.log(formatPortLog(result.portLog));
  }
}

main();
