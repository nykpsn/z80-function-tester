# Z80 Function Tester

Load Z80 assembly, assemble it to binary, run it on an emulated Z80, and inspect
the resulting CPU registers, flags, and memory. Available as a **console app** and
a **web GUI**.

Emulation uses Lawrence Kesteloot's [`z80-emulator`](https://github.com/lkesteloot/trs80)
(full opcode coverage, cycle counting). Assembly uses a pluggable backend:
[`z80-asm`](https://github.com/lkesteloot/trs80) (in-process, the default) or the
external [WLA-DX](https://github.com/vhelin/wla-dx) toolchain. See
[Assemblers](#assemblers).

## How it works

The runner is built for testing a routine like a function call:

1. Your source is assembled into a 64 KB flat memory image.
2. Registers and memory are seeded with the inputs you specify.
3. A **sentinel return address** is pushed on the stack and `PC` is set to the
   entry point. When your code's final `RET` lands on the sentinel, execution
   stops cleanly (`stopReason: "returned"`).
4. Execution also stops on `HALT`, or at an instruction cap (to escape infinite
   loops).
5. You get back the final registers (main and alternate pairs), decoded flags,
   T-state count, any memory ranges you asked to dump, and a log of bytes written
   to I/O ports via `OUT`.

## Setup

```bash
npm install
```

## Console app

```bash
npm run cli -- <file.asm> [options]
```

Options:

| Option | Meaning |
| --- | --- |
| `--reg <name>=<value>` | Seed a register before running. Names: `af bc de hl ix iy sp pc a b c d e h l`. Values are decimal or `0x`/`$` hex. |
| `--dump <start>[:<len>]` | Hex-dump a memory range after running (length defaults to 16). |
| `--port [<p>[,<p>...]]` | Log `OUT` writes and print them as a per-port byte stream. No value (or `all`) logs every port; or list ports, e.g. `--port 0xFE,0xFF`. |
| `--entry <addr>` | Override the entry point (`PC`). |
| `--sp <addr>` | Set the stack pointer (default `0xFF00`). |
| `--max <n>` | Instruction cap before giving up (default 5,000,000). |
| `--listing` | Print the assembled listing (address + bytes per line). |
| `--assembler <name>` | `z80asm` (default, in-process) or `wla` (external WLA-DX). |

Example:

```bash
npm run cli -- examples/multiply.asm --reg b=6 --reg c=7 --dump 0x9000:2
```

Output ends with the register/flag report and the requested memory dump
(`6 * 7 = 0x2A` in `HL` and at `0x9000`).

To see the port stream, run a program that uses `OUT`:

```bash
npm run cli -- examples/io.asm --port 0xFE
```

## Web GUI

```bash
npm run web
```

Then open <http://localhost:3000>. Set `PORT` to change the port.

The page is laid out in two columns: **source + Memory/Port** on the left,
**Assembler listing + Result** on the right.

- **Tabs** — each tab holds a separate function/source. They are **compiled
  together** into one program, so a routine in one tab can `call` a label defined
  in another. Click **+ tab** to add one, the tab name to rename it, **×** to close.
  Give each function its own `org` so they don't overlap.
- **Assembler** — a dropdown selects the backend (`z80-asm` built-in, or WLA-DX).
- **Inputs** — under the editor: a **start label** to begin from, **registers in**
  to seed (e.g. `b=6 c=7 hl=0x1234`), a **memory dump** range (e.g. `0x9000:8`),
  a **port dump** (port number(s) to log `OUT` writes for; blank = all ports), and
  a **stack pointer**. Numbers are decimal or `0x`/`$` hex.
- **Start from label** — pick which label execution begins at. Click **Compile**
  to assemble without running and refresh the label list, then choose a start
  label and **Run** (or `Ctrl`/`Cmd`+`Enter`). The label list also refreshes
  automatically as you type.
- **Result panel** — shows the register pairs and flags. Registers are the main
  pairs (`AF BC DE HL`), the alternate pairs (`AF' BC' DE' HL'`), and `IX IY SP PC`,
  in hex. Any register that differs from its starting (seeded) value is highlighted
  with its `was …` original value.
- **Step debugger** — every run records a per-instruction trace. Use the slider,
  the ◀ ▶ buttons, or the keyboard arrows to scrub through execution; the
  register/flag panel and the highlighted listing line update for each step.
  (Traces are capped — see `maxTrace` — for very long runs.)
- **Memory / Port panel** — two sub-tabs. **Memory** shows the requested memory
  dump ranges (hex + ASCII). **Port** shows the bytes written to the logged port(s)
  via `OUT`, as a stream per port (hex + ASCII). The port match is on the low 8
  bits of the address, so both `OUT (n),A` and `OUT (C),r` are captured.
- The **Assembler listing** panel shows the assembled bytes with `tab:line`
  locations. Assembly errors are reported per tab.

## Assemblers

The assembler is pluggable (CLI `--assembler`, GUI dropdown, or `assembler` in the
`/api/run` body). Both backends produce the same result shape (bytes, symbols,
entry point, errors).

### `z80asm` (default)

The in-process [`z80-asm`](https://github.com/lkesteloot/trs80) library. No install
needed, and it gives a full per-line address/byte listing (used for the step
debugger's instruction highlighting). Use plain directives like `org 0x8000`.

> Note: `z80-asm` reserves register names, so you can't use `b`, `c`, `hl`, etc. as
> labels.

### `wla` (WLA-DX, external)

Shells out to the [WLA-DX](https://github.com/vhelin/wla-dx) toolchain. The
`wla-z80` and `wlalink` executables are located in this order: the `WLA_Z80` /
`WLALINK` environment variables (full paths), then a copy placed in the project
root (e.g. `wla-z80.exe` / `wlalink.exe`), then your `PATH`. The simplest setup is
to copy the two executables into the project folder.

- **Memory map** — if your source doesn't define a `.MEMORYMAP`, a single 64 KB
  ROM bank at `$0000` is auto-prepended (and `.ORG $0000` if you didn't specify
  one), so the linked binary maps directly onto memory. Provide your own
  `.MEMORYMAP` for full control.
- **Syntax differs** — WLA uses its own directives (`.ORG`, `.db`, `.MEMORYMAP`,
  etc.); source written for `z80-asm` won't assemble unchanged under WLA.
- **Full integration** — the backend assembles/links with list-file output
  (`wla-z80 -i`, `wlalink -i`) and a symbol file, so you get the per-line
  address/byte listing (with step-debugger highlighting), the label list for
  "start from label", and line-numbered errors — same as the built-in assembler.

## Project layout

```
src/
  core/
    types.ts       Shared types
    assemble.ts    Assembler dispatcher + z80-asm backend; extract symbols
    wla.ts         WLA-DX backend (shells out to wla-z80 + wlalink)
    machine.ts     64 KB Hal + Z80 instance, with port-write logging
    run.ts         Seed state, run to RET/HALT/cap, snapshot result + trace
    format.ts      Text rendering for the CLI
  cli.ts           Console entry point
  server.ts        Dependency-free HTTP server + /api/run
public/
  index.html       Web GUI (markup + styles)
  app.js           Web GUI logic
examples/
  multiply.asm     8-bit unsigned multiply
  io.asm           Writes a string to a port via OUT (for --port)
```

> **Note:** the CLI covers run-and-inspect plus memory and port dumps. The step
> debugger and alternate-register display are currently surfaced only in the web
> GUI (and the `/api/run` endpoint).
