import type { RunResult, DumpRange, PortWrite } from "./types.js";

export const hex = (value: number, width: number): string =>
  value.toString(16).toUpperCase().padStart(width, "0");

const STOP_LABEL: Record<RunResult["stopReason"], string> = {
  returned: "function returned (RET to sentinel)",
  halted: "HALT executed",
  "max-instructions": "stopped at instruction cap (possible infinite loop)",
};

/** Render the post-run register/flag report as text. */
export function formatResult(result: RunResult): string {
  const r = result.registers;
  const f = result.flags;
  const flagStr = (["S", "Z", "H", "P", "N", "C"] as const)
    .map((name) => (f[name] ? name : name.toLowerCase()))
    .join(" ");

  const lines = [
    `Stop reason : ${STOP_LABEL[result.stopReason]}`,
    ...(result.loopsCompleted > 1 ? [`Calls       : ${result.loopsCompleted}`] : []),
    `Instructions: ${result.instructionsExecuted.toLocaleString()}`,
    `T-states    : ${result.tStates.toLocaleString()}`,
    "",
    "Registers:",
    `  AF=${hex(r.af, 4)}  BC=${hex(r.bc, 4)}  DE=${hex(r.de, 4)}  HL=${hex(r.hl, 4)}`,
    `  IX=${hex(r.ix, 4)}  IY=${hex(r.iy, 4)}  SP=${hex(r.sp, 4)}  PC=${hex(r.pc, 4)}`,
    `  A=${hex(r.a, 2)} B=${hex(r.b, 2)} C=${hex(r.c, 2)} D=${hex(r.d, 2)} E=${hex(r.e, 2)} H=${hex(r.h, 2)} L=${hex(r.l, 2)}`,
    "",
    `Flags: ${flagStr}   (uppercase = set)`,
  ];
  return lines.join("\n");
}

/** Render a hex dump of a memory range. */
export function formatMemory(memory: Uint8Array, range: DumpRange): string {
  const out: string[] = [`Memory ${hex(range.start, 4)}..${hex(range.start + range.length - 1, 4)}:`];
  for (let row = 0; row < range.length; row += 16) {
    const addr = (range.start + row) & 0xffff;
    const cells: string[] = [];
    const ascii: string[] = [];
    for (let i = 0; i < 16 && row + i < range.length; i++) {
      const b = memory[(range.start + row + i) & 0xffff];
      cells.push(hex(b, 2));
      ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".");
    }
    out.push(`  ${hex(addr, 4)}  ${cells.join(" ").padEnd(16 * 3 - 1)}  ${ascii.join("")}`);
  }
  return out.join("\n");
}

/** Render OUT writes grouped per port, each as a byte stream (hex + ASCII). */
export function formatPortLog(log: PortWrite[]): string {
  if (log.length === 0) return "Port writes: (none)";

  const groups = new Map<number, number[]>();
  for (const { port, value } of log) {
    let bytes = groups.get(port);
    if (!bytes) groups.set(port, (bytes = []));
    bytes.push(value);
  }

  const blocks: string[] = [];
  for (const [port, vals] of groups) {
    const rows: string[] = [];
    for (let row = 0; row < vals.length; row += 16) {
      const cells: string[] = [];
      const ascii: string[] = [];
      for (let i = 0; i < 16 && row + i < vals.length; i++) {
        const b = vals[row + i];
        cells.push(hex(b, 2));
        ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".");
      }
      rows.push(`  ${cells.join(" ").padEnd(16 * 3 - 1)}  ${ascii.join("")}`);
    }
    blocks.push(`Port ${hex(port, 2)} — ${vals.length} byte(s):\n${rows.join("\n")}`);
  }
  return blocks.join("\n\n");
}
