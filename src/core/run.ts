import { Flag } from "z80-base";
import type { RegisterSet } from "z80-base";
import { FlatMachine } from "./machine.js";
import { assemble } from "./assemble.js";
import type {
  AssembleResult,
  AssembleOptions,
  RunOptions,
  RunResult,
  StopReason,
  FlagState,
  RegisterSnapshot,
  TraceStep,
} from "./types.js";

const DEFAULT_SP = 0xff00;
const DEFAULT_SENTINEL = 0xffff;
const DEFAULT_MAX_INSTRUCTIONS = 5_000_000;
const DEFAULT_MAX_TRACE = 50_000;

/** Run an already-assembled image and return the final machine state. */
export function run(assembled: AssembleResult, options: RunOptions = {}): RunResult {
  const machine = new FlatMachine(options.logPorts);
  machine.loadBytes(assembled.bytes);

  // Seed memory pokes.
  if (options.memory) {
    for (const [addr, value] of Object.entries(options.memory)) {
      machine.memory[Number(addr) & 0xffff] = value & 0xff;
    }
  }

  const regs = machine.cpu.regs;
  const sp = options.stackPointer ?? DEFAULT_SP;
  const sentinel = options.returnSentinel ?? DEFAULT_SENTINEL;
  regs.sp = sp;

  // Push the sentinel return address so a final RET lands on it.
  regs.sp = (regs.sp - 1) & 0xffff;
  machine.memory[regs.sp] = (sentinel >> 8) & 0xff;
  regs.sp = (regs.sp - 1) & 0xffff;
  machine.memory[regs.sp] = sentinel & 0xff;

  // Seed registers (pairs first, then 8-bit so the latter win on conflict).
  const r = options.registers ?? {};
  if (r.af !== undefined) regs.af = r.af & 0xffff;
  if (r.bc !== undefined) regs.bc = r.bc & 0xffff;
  if (r.de !== undefined) regs.de = r.de & 0xffff;
  if (r.hl !== undefined) regs.hl = r.hl & 0xffff;
  if (r.ix !== undefined) regs.ix = r.ix & 0xffff;
  if (r.iy !== undefined) regs.iy = r.iy & 0xffff;
  if (r.a !== undefined) regs.a = r.a & 0xff;
  if (r.b !== undefined) regs.b = r.b & 0xff;
  if (r.c !== undefined) regs.c = r.c & 0xff;
  if (r.d !== undefined) regs.d = r.d & 0xff;
  if (r.e !== undefined) regs.e = r.e & 0xff;
  if (r.h !== undefined) regs.h = r.h & 0xff;
  if (r.l !== undefined) regs.l = r.l & 0xff;

  const entry = r.pc ?? options.entryPoint ?? assembled.entryPoint ?? 0;
  regs.pc = entry & 0xffff;

  const initial = { registers: snapshot(regs), flags: decodeFlags(regs.f) };

  const trace: TraceStep[] | undefined = options.trace ? [] : undefined;
  const maxTrace = options.maxTrace ?? DEFAULT_MAX_TRACE;
  // When tracing, cap execution at the trace size so the whole run is captured.
  const maxInstructions = options.trace
    ? Math.min(options.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS, maxTrace)
    : options.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS;

  let stopReason: StopReason = "max-instructions";
  let executed = 0;
  let traceTruncated = false;

  // Record the starting state as step 0.
  if (trace) trace.push({ pc: regs.pc, registers: snapshot(regs), flags: decodeFlags(regs.f) });

  while (executed < maxInstructions) {
    if (regs.pc === sentinel) {
      stopReason = "returned";
      break;
    }
    machine.cpu.step();
    executed++;
    if (trace) {
      if (trace.length <= maxTrace) {
        trace.push({ pc: regs.pc, registers: snapshot(regs), flags: decodeFlags(regs.f) });
      } else {
        traceTruncated = true;
      }
    }
    if (regs.halted) {
      stopReason = "halted";
      break;
    }
  }

  return {
    stopReason,
    instructionsExecuted: executed,
    tStates: machine.tStateCount,
    registers: snapshot(regs),
    flags: decodeFlags(regs.f),
    initial,
    trace,
    traceTruncated: traceTruncated || undefined,
    portLog: machine.portLog,
    memory: machine.memory,
  };
}

function snapshot(regs: RegisterSet): RegisterSnapshot {
  return {
    af: regs.af, bc: regs.bc, de: regs.de, hl: regs.hl,
    afPrime: regs.afPrime, bcPrime: regs.bcPrime, dePrime: regs.dePrime, hlPrime: regs.hlPrime,
    ix: regs.ix, iy: regs.iy, sp: regs.sp, pc: regs.pc,
    a: regs.a, b: regs.b, c: regs.c, d: regs.d,
    e: regs.e, h: regs.h, l: regs.l, f: regs.f,
  };
}

/** Assemble then run in one call. Throws if assembly fails. */
export function assembleAndRun(source: string, options: RunOptions & AssembleOptions = {}): {
  assembled: AssembleResult;
  result: RunResult;
} {
  const assembled = assemble(source, { assembler: options.assembler });
  if (!assembled.ok) {
    const msg = assembled.errors
      .map((e) => `  line ${e.lineNumber ?? "?"}: ${e.message}`)
      .join("\n");
    throw new Error(`Assembly failed:\n${msg || "  (no bytes produced)"}`);
  }
  return { assembled, result: run(assembled, options) };
}

function decodeFlags(f: number): FlagState {
  return {
    S: (f & Flag.S) !== 0,
    Z: (f & Flag.Z) !== 0,
    H: (f & Flag.H) !== 0,
    P: (f & Flag.P) !== 0,
    N: (f & Flag.N) !== 0,
    C: (f & Flag.C) !== 0,
  };
}
