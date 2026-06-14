import { Asm } from "z80-asm";
import type { AssembleResult, AssembleOptions, ListingLine, SymbolEntry } from "./types.js";
import { assembleWla } from "./wla.js";

/** Minimal shape of a z80-asm scope (the class isn't exported). */
interface ScopeLike {
  symbols: Map<string, { name: string; value: number }>;
}

const VIRTUAL_PATH = "main.asm";

/**
 * Assemble Z80 source into bytes + a listing, using the selected backend.
 * Defaults to the in-process z80-asm assembler.
 */
export function assemble(source: string, options: AssembleOptions = {}): AssembleResult {
  return options.assembler === "wla" ? assembleWla(source) : assembleZ80Asm(source);
}

/**
 * Assemble with z80-asm (in-process).
 *
 * z80-asm reads source through a FileReader callback, so we hand it an
 * in-memory reader that serves the provided source for the virtual path.
 */
function assembleZ80Asm(source: string): AssembleResult {
  const lines = source.split(/\r?\n/);

  const asm = new Asm((pathname: string): string[] | undefined => {
    if (pathname === VIRTUAL_PATH) return lines;
    return undefined;
  });

  const sourceFile = asm.assembleFile(VIRTUAL_PATH);

  const listing: ListingLine[] = [];
  const errors: AssembleResult["errors"] = [];
  const bytes = new Map<number, number>();
  let firstCodeAddress: number | undefined;

  if (sourceFile) {
    for (const al of sourceFile.assembledLines) {
      listing.push({
        lineNumber: al.lineNumber,
        address: al.address,
        binary: al.binary,
        text: al.line,
        error: al.error,
      });

      if (al.error) {
        errors.push({ lineNumber: al.lineNumber, message: al.error });
      }

      if (al.binary.length > 0) {
        if (firstCodeAddress === undefined) firstCodeAddress = al.address;
        for (let i = 0; i < al.binary.length; i++) {
          bytes.set((al.address + i) & 0xffff, al.binary[i] & 0xff);
        }
      }
    }
  } else {
    errors.push({ lineNumber: undefined, message: "Assembler could not load the source." });
  }

  const symbols: SymbolEntry[] = [];
  for (const scope of asm.scopes as unknown as ScopeLike[]) {
    for (const info of scope.symbols.values()) {
      symbols.push({ name: info.name, value: info.value & 0xffff });
    }
  }
  symbols.sort((a, b) => a.value - b.value || a.name.localeCompare(b.name));

  return {
    ok: errors.length === 0 && bytes.size > 0,
    bytes,
    entryPoint: asm.entryPoint ?? firstCodeAddress,
    symbols,
    listing,
    errors,
  };
}
