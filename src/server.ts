import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { assemble } from "./core/assemble.js";
import { run } from "./core/run.js";
import type { RegisterValues, DumpRange, AssemblerId } from "./core/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const PORT = Number(process.env.PORT ?? 3000);

interface RunRequest {
  source: string;
  registers?: RegisterValues;
  dumps?: DumpRange[];
  entry?: number;
  /** Name of a label to start execution from (overrides entry). */
  entryLabel?: string;
  sp?: number;
  maxInstructions?: number;
  /** How many times to call the function in sequence (default 1). */
  loops?: number;
  /** If true, assemble only and return symbols/listing without executing. */
  compileOnly?: boolean;
  /** If true, record per-instruction snapshots for the step debugger. */
  trace?: boolean;
  maxTrace?: number;
  /** Ports whose OUT writes to log (empty = all). */
  ports?: number[];
  /** Assembler backend: "z80asm" (default) or "wla". */
  assembler?: AssemblerId;
}

function handleRun(body: RunRequest) {
  const assembler: AssemblerId = body.assembler === "wla" ? "wla" : "z80asm";
  const assembled = assemble(body.source ?? "", { assembler });

  const response: Record<string, unknown> = {
    ok: assembled.ok,
    assembler,
    errors: assembled.errors,
    entryPoint: assembled.entryPoint,
    byteCount: assembled.bytes.size,
    symbols: assembled.symbols,
    listing: assembled.listing.map((l) => ({
      lineNumber: l.lineNumber,
      address: l.address,
      binary: l.binary,
      text: l.text,
      error: l.error,
    })),
  };

  if (!assembled.ok || body.compileOnly) return response;

  // Resolve the entry point: explicit label wins, then numeric entry, then auto.
  let entryPoint = body.entry;
  if (body.entryLabel) {
    const sym = assembled.symbols.find((s) => s.name === body.entryLabel);
    if (sym) {
      entryPoint = sym.value;
    } else {
      response.warning = `Start label "${body.entryLabel}" not found; used auto entry point.`;
    }
  }

  const result = run(assembled, {
    registers: body.registers,
    entryPoint,
    stackPointer: body.sp,
    maxInstructions: body.maxInstructions,
    loops: body.loops,
    trace: body.trace,
    maxTrace: body.maxTrace,
    logPorts: body.ports,
  });

  const dumps = (body.dumps ?? []).map((d) => {
    const bytes: number[] = [];
    for (let i = 0; i < d.length; i++) bytes.push(result.memory[(d.start + i) & 0xffff]);
    return { start: d.start, length: d.length, bytes };
  });

  response.usedEntryPoint = entryPoint ?? assembled.entryPoint;
  response.result = {
    stopReason: result.stopReason,
    instructionsExecuted: result.instructionsExecuted,
    loopsCompleted: result.loopsCompleted,
    tStates: result.tStates,
    registers: result.registers,
    flags: result.flags,
    initial: result.initial,
    trace: result.trace,
    traceTruncated: result.traceTruncated,
    portLog: result.portLog,
    // Graph data (present only on traced runs): the starting 64KB image
    // (base64) plus per-step memory writes, so the client can plot any byte.
    memInitial: result.initialMemory
      ? Buffer.from(result.initialMemory).toString("base64")
      : undefined,
    memWrites: result.memWrites,
  };
  response.dumps = dumps;
  return response;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/run") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      let body: RunRequest;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON body" }));
        return;
      }
      let payload: unknown;
      try {
        payload = handleRun(body);
      } catch (e) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, errors: [{ message: (e as Error).message }] }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return;
    }

    // Static files.
    const urlPath = req.url === "/" || !req.url ? "/index.html" : req.url.split("?")[0];
    const safePath = join(PUBLIC_DIR, urlPath.replace(/\.\.+/g, ""));
    try {
      const data = await readFile(safePath);
      const ext = safePath.slice(safePath.lastIndexOf("."));
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "cache-control": "no-cache",
      });
      res.end(data);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
    }
  } catch (e) {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end(`Server error: ${(e as Error).message}`);
  }
});

server.listen(PORT, () => {
  console.log(`Z80 function tester GUI running at http://localhost:${PORT}`);
});
