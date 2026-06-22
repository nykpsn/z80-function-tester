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
const DEFAULT_MAX_INSTRUCTIONS = 50_000_000;
const DEFAULT_MAX_TRACE = 500_000;

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
  const entry = (options.registers?.pc ?? options.entryPoint ?? assembled.entryPoint ?? 0) & 0xffff;
  const loops = Math.max(1, Math.floor(options.loops ?? 1));

  // Set up one call: push the sentinel return address onto the current stack so
  // a final RET lands on it, then point PC at the entry. Only PC is reset; SP and
  // all other registers carry over, so an unbalanced function's stack effects
  // accumulate across loop iterations.
  const setupCall = () => {
    regs.sp = (regs.sp - 1) & 0xffff;
    machine.memory[regs.sp] = (sentinel >> 8) & 0xff;
    regs.sp = (regs.sp - 1) & 0xffff;
    machine.memory[regs.sp] = sentinel & 0xff;
    regs.pc = entry;
  };

  // Seed registers once, before the first call (pairs first, then 8-bit so the
  // latter win on conflict). Subsequent loops reuse the prior call's state.
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

  // Seed the stack pointer once; later calls inherit wherever the prior one left it.
  regs.sp = sp;
  setupCall();

  const initial = { registers: snapshot(regs), flags: decodeFlags(regs.f) };

  // When tracing, capture the starting memory image and per-step memory writes
  // so a client can reconstruct any byte's value at any step.
  const initialMemory = options.trace ? machine.memory.slice() : undefined;
  const memWrites: { step: number; addr: number; value: number }[] | undefined =
    options.trace ? [] : undefined;
  let memWriteCursor = 0;
  if (options.trace) machine.captureWrites = true;

  const trace: TraceStep[] | undefined = options.trace ? [] : undefined;
  const maxTrace = options.maxTrace ?? DEFAULT_MAX_TRACE;
  // When tracing, cap execution at the trace size so the whole run is captured.
  const maxInstructions = options.trace
    ? Math.min(options.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS, maxTrace)
    : options.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS;

  let stopReason: StopReason = "max-instructions";
  let executed = 0;
  let traceTruncated = false;
  let loopsCompleted = 0;

  // Record the starting state as step 0.
  if (trace) trace.push({ pc: regs.pc, registers: snapshot(regs), flags: decodeFlags(regs.f) });

  while (executed < maxInstructions) {
    if (regs.pc === sentinel) {
      loopsCompleted++;
      if (loopsCompleted >= loops) {
        stopReason = "returned";
        break;
      }
      // Begin the next call without re-seeding registers; PC/SP are reset while
      // the rest of the register and memory state carries over.
      setupCall();
      continue;
    }
    machine.cpu.step();
    executed++;
    if (trace) {
      if (trace.length <= maxTrace) {
        trace.push({ pc: regs.pc, registers: snapshot(regs), flags: decodeFlags(regs.f) });
        // Tag writes from this instruction with the step they become visible in.
        for (; memWriteCursor < machine.memWriteLog.length; memWriteCursor++) {
          const w = machine.memWriteLog[memWriteCursor];
          memWrites!.push({ step: executed, addr: w.addr, value: w.value });
        }
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
    loopsCompleted,
    tStates: machine.tStateCount,
    registers: snapshot(regs),
    flags: decodeFlags(regs.f),
    initial,
    trace,
    traceTruncated: traceTruncated || undefined,
    portLog: machine.portLog,
    memory: machine.memory,
    initialMemory,
    memWrites,
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
