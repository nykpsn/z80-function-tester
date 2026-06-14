import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssembleResult, ListingLine, SymbolEntry } from "./types.js";

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Resolve a WLA tool: an explicit env var wins, then a binary copied into the
 * project root or the current directory, otherwise fall back to a bare name
 * (looked up on PATH).
 */
function resolveTool(envVal: string | undefined, baseName: string): string {
  if (envVal) return envVal;
  const exe = process.platform === "win32" ? `${baseName}.exe` : baseName;
  for (const candidate of [join(PROJECT_ROOT, exe), join(process.cwd(), exe)]) {
    if (existsSync(candidate)) return candidate;
  }
  return baseName;
}

// Executable paths; override via env, else local copy, else PATH.
const WLA_Z80 = resolveTool(process.env.WLA_Z80, "wla-z80");
const WLALINK = resolveTool(process.env.WLALINK, "wlalink");

const NOT_FOUND_MSG =
  `WLA-DX not found (expected "${WLA_Z80}" and "${WLALINK}" on PATH). ` +
  `Install WLA-DX or set the WLA_Z80 / WLALINK environment variables.`;

/**
 * A single 64KB ROM bank mapped at $0000. With this layout the linker's output
 * binary is a direct address->byte image of the whole 64KB space, which we can
 * load straight into the emulator.
 */
const MEMORYMAP_BOILERPLATE = `.MEMORYMAP
  DEFAULTSLOT 0
  SLOTSIZE $10000
  SLOT 0 $0000
.ENDME
.ROMBANKMAP
  BANKSTOTAL 1
  BANKSIZE $10000
  BANKS 1
.ENDRO
.BANK 0 SLOT 0
`;

/** Assemble + link with the external WLA-DX toolchain (wla-z80 + wlalink). */
export function assembleWla(source: string): AssembleResult {
  // Auto-prepend a 64KB memory map unless the source defines its own.
  const hasMap = /\.memorymap/i.test(source);
  let fullSource = source;
  if (!hasMap) {
    let pre = MEMORYMAP_BOILERPLATE;
    if (!/\.orga?\b/i.test(source)) pre += ".ORG $0000\n";
    fullSource = pre + source;
  }
  // Lines we injected, so we can map WLA's error line numbers back to the user's.
  const prependLines = fullSource.split("\n").length - source.split("\n").length;

  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "z80wla-"));
    const srcPath = join(dir, "in.s");
    const objPath = join(dir, "in.o");
    const linkPath = join(dir, "link.lnk");
    const binPath = join(dir, "out.bin");
    const symPath = join(dir, "out.sym");
    const lstPath = join(dir, "in.lst");

    writeFileSync(srcPath, fullSource, "utf8");
    writeFileSync(linkPath, "[objects]\nin.o\n", "utf8");

    // Assemble to object file (-i embeds list-file info).
    try {
      execFileSync(WLA_Z80, ["-i", "-o", objPath, "in.s"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return errorResult(source, execFailure(e, prependLines));
    }

    // Link to a flat binary, emitting a symbol file (-s) and list file (-i).
    try {
      execFileSync(WLALINK, ["-i", "-s", "-d", "link.lnk", "out.bin"], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return errorResult(source, execFailure(e, prependLines));
    }

    const bin = readFileSync(binPath);
    const bytes = new Map<number, number>();
    let first = -1;
    let last = -1;
    for (let i = 0; i < bin.length; i++) {
      if (bin[i] !== 0) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first >= 0) {
      for (let a = first; a <= last; a++) bytes.set(a & 0xffff, bin[a]);
    }

    const symbols = existsSync(symPath) ? parseWlaSymbols(readFileSync(symPath, "utf8")) : [];
    symbols.sort((a, b) => a.value - b.value || a.name.localeCompare(b.name));

    const entryPoint = symbols.length > 0 ? symbols[0].value : first >= 0 ? first : undefined;

    const listing = existsSync(lstPath)
      ? parseWlaListing(readFileSync(lstPath, "utf8"), source, prependLines)
      : plainListing(source);

    return {
      ok: bytes.size > 0,
      bytes,
      entryPoint,
      symbols,
      listing,
      errors: bytes.size > 0 ? [] : [{ lineNumber: undefined, message: "WLA produced no code bytes." }],
    };
  } catch (e) {
    const msg = isENOENT(e) ? NOT_FOUND_MSG : `WLA-DX failed: ${(e as Error).message}`;
    return errorResult(source, [{ lineNumber: undefined, message: msg }]);
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

function errorResult(source: string, errors: AssembleResult["errors"]): AssembleResult {
  return {
    ok: false,
    bytes: new Map(),
    entryPoint: undefined,
    symbols: [],
    listing: plainListing(source),
    errors: errors.length > 0 ? errors : [{ lineNumber: undefined, message: "Unknown WLA-DX error." }],
  };
}

/** Source lines without per-line addresses (used when no list file is available). */
function plainListing(source: string): ListingLine[] {
  return source.split(/\r?\n/).map((text, i) => ({
    lineNumber: i,
    address: 0,
    binary: [],
    text,
  }));
}

/**
 * Build a listing from wlalink's `.lst` file, overlaying per-line addresses and
 * bytes onto the user's source. The list file's line numbers count the prepended
 * boilerplate, so they're shifted back by `prependLines`.
 *
 * List rows look like:  ` 14 0000 0000 8000 8000   3E 05   ld a,5`
 *                        line bank slot PC  offset hex...   source
 */
function parseWlaListing(lst: string, source: string, prependLines: number): ListingLine[] {
  const listing = plainListing(source);
  const rowRe = /^\s*(\d+)\s+[0-9a-f]{4}\s+[0-9a-f]{4}\s+([0-9a-f]{4})\s+[0-9a-f]{4}\s+((?:[0-9a-f]{2} )+)/i;

  for (const raw of lst.split(/\r?\n/)) {
    const m = raw.match(rowRe);
    if (!m) continue;
    const userLine = Number(m[1]) - prependLines - 1; // -> 0-based into user source
    if (userLine < 0 || userLine >= listing.length) continue;
    listing[userLine].address = parseInt(m[2], 16);
    listing[userLine].binary = m[3].trim().split(/\s+/).map((h) => parseInt(h, 16));
  }

  // Give address-less lines (comments, labels, directives) the running address
  // so the listing reads sensibly; only lines with bytes get highlighted.
  let lastAddr = 0;
  for (const line of listing) {
    if (line.binary.length > 0) {
      lastAddr = line.address + line.binary.length;
    } else {
      line.address = lastAddr;
    }
  }
  return listing;
}

/** Turn an exec failure into assemble errors (ENOENT -> "not installed"). */
function execFailure(e: unknown, prependLines: number): AssembleResult["errors"] {
  if (isENOENT(e)) return [{ lineNumber: undefined, message: NOT_FOUND_MSG }];
  return parseWlaErrors(execErrText(e), prependLines);
}

/** Combine stdout+stderr captured on an execFileSync error. */
function execErrText(e: unknown): string {
  const err = e as { stderr?: Buffer; stdout?: Buffer };
  return `${err.stdout?.toString() ?? ""}\n${err.stderr?.toString() ?? ""}`;
}

function isENOENT(e: unknown): boolean {
  return (e as { code?: string })?.code === "ENOENT";
}

/**
 * Parse WLA diagnostics. Handles both "... (in.s line N)" and "in.s:N:" forms.
 * Line numbers are shifted back by the boilerplate we prepended.
 */
function parseWlaErrors(text: string, prependLines: number): AssembleResult["errors"] {
  const out: AssembleResult["errors"] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || !/error|warning/i.test(line)) continue;
    const m = line.match(/line\s+(\d+)/i) ?? line.match(/\.s:(\d+):/i) ?? line.match(/:(\d+):/);
    let lineNumber: number | undefined;
    if (m) {
      const n = Number(m[1]) - prependLines;
      lineNumber = n >= 1 ? n - 1 : undefined; // to 0-based, drop boilerplate hits
    }
    out.push({ lineNumber, message: line });
  }
  if (out.length === 0 && text.trim()) {
    out.push({ lineNumber: undefined, message: text.trim() });
  }
  return out;
}

/**
 * Parse a NO$GMB-style .sym file. Symbol lines look like:
 *   00:8000 multiply
 * Section headers in brackets are ignored.
 */
function parseWlaSymbols(text: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];
  let inLabels = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";")) continue;
    if (line.startsWith("[")) {
      inLabels = /\[labels\]/i.test(line);
      continue;
    }
    if (!inLabels) continue;
    const m = line.match(/^([0-9a-f]{2}):([0-9a-f]{4})\s+(\S+)/i);
    if (m) symbols.push({ name: m[3], value: parseInt(m[2], 16) & 0xffff });
  }
  return symbols;
}
