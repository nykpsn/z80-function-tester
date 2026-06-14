/** Shared types for the Z80 function tester core. */

/** One assembled source line, mirroring what z80-asm produces. */
export interface ListingLine {
  lineNumber: number | undefined;
  address: number;
  /** Assembled bytes for this line (may be empty). */
  binary: number[];
  /** Original source text. */
  text: string;
  /** Assembly error for this line, if any. */
  error?: string;
}

/** Which assembler backend to use. */
export type AssemblerId = "z80asm" | "wla";

export interface AssembleOptions {
  /** Assembler backend (default "z80asm"). */
  assembler?: AssemblerId;
}

/** A defined symbol (label or equ constant) and its value/address. */
export interface SymbolEntry {
  name: string;
  value: number;
}

export interface AssembleResult {
  ok: boolean;
  /** Address -> byte for every assembled byte. */
  bytes: Map<number, number>;
  /** Entry point chosen by the assembler, or first code address. */
  entryPoint: number | undefined;
  /** All defined symbols, sorted by value. */
  symbols: SymbolEntry[];
  listing: ListingLine[];
  errors: { lineNumber: number | undefined; message: string }[];
}

/** Registers the caller may set before running, or read after. */
export interface RegisterValues {
  af?: number; bc?: number; de?: number; hl?: number;
  ix?: number; iy?: number; sp?: number; pc?: number;
  a?: number; b?: number; c?: number; d?: number;
  e?: number; h?: number; l?: number;
}

export interface RunOptions {
  /** Register values to seed before execution. */
  registers?: RegisterValues;
  /** Bytes to poke into memory before running: address -> value. */
  memory?: Record<number, number>;
  /** Stack pointer to set before calling (default 0xff00). */
  stackPointer?: number;
  /** Address pushed as the return address; run stops when PC reaches it. */
  returnSentinel?: number;
  /** Hard cap on executed instructions to escape infinite loops. */
  maxInstructions?: number;
  /** Override the entry point (PC) chosen from the assembly. */
  entryPoint?: number;
  /** Record a per-instruction register/flag snapshot for stepping. */
  trace?: boolean;
  /** Max snapshots to record when tracing (also caps execution). */
  maxTrace?: number;
  /** Ports whose OUT writes should be logged. Empty/undefined = log all ports. */
  logPorts?: number[];
}

/** A single byte written to a port via OUT, in execution order. */
export interface PortWrite {
  port: number;
  value: number;
}

export type StopReason =
  | "returned"        // PC reached the return sentinel (function RET'd)
  | "halted"          // executed a HALT instruction
  | "max-instructions"; // hit the safety cap

export interface FlagState {
  S: boolean; Z: boolean; H: boolean;
  P: boolean; N: boolean; C: boolean;
}

export interface RegisterSnapshot {
  af: number; bc: number; de: number; hl: number;
  afPrime: number; bcPrime: number; dePrime: number; hlPrime: number;
  ix: number; iy: number; sp: number; pc: number;
  a: number; b: number; c: number; d: number;
  e: number; h: number; l: number; f: number;
}

/** One step of execution, captured for the debugger. */
export interface TraceStep {
  /** PC of the instruction about to execute at this snapshot. */
  pc: number;
  registers: RegisterSnapshot;
  flags: FlagState;
}

export interface RunResult {
  stopReason: StopReason;
  instructionsExecuted: number;
  tStates: number;
  /** Final 16-bit register pairs and useful 8-bit views. */
  registers: RegisterSnapshot;
  flags: FlagState;
  /** Register/flag state right before the first instruction ran. */
  initial: { registers: RegisterSnapshot; flags: FlagState };
  /** Per-instruction snapshots, present when tracing was requested. */
  trace?: TraceStep[];
  /** True if tracing stopped at the trace cap before the program ended. */
  traceTruncated?: boolean;
  /** Bytes written to logged ports via OUT, in execution order. */
  portLog: PortWrite[];
  /** Snapshot of the full 64KB after the run. */
  memory: Uint8Array;
}

export interface DumpRange {
  start: number;
  length: number;
}
