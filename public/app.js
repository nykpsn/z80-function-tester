// Frontend logic for the Z80 Function Tester.
// Multiple source tabs are compiled together into one program; you pick which
// label to start execution from.

const TAB_MULTIPLY = `; B * C -> HL, low byte stored at 0x9000
        .org    0x8000
multiply:
        ld      hl, 0
        ld      a, c
        or      a
        jr      z, m_done
        ld      d, 0
        ld      e, b
m_loop:
        add     hl, de
        dec     a
        jr      nz, m_loop
m_done:
        ld      a, l
        ld      (0x9000), a
        ret
`;

const TAB_ADDBC = `; HL = B + C
        .org    0x8100
addbc:
        ld      h, 0
        ld      l, b
        ld      d, 0
        ld      e, c
        add     hl, de
        ret
`;

const $ = (id) => document.getElementById(id);
const REG_NAMES = ["af","bc","de","hl","ix","iy","sp","pc","a","b","c","d","e","h","l"];

// ---- Tab state ---------------------------------------------------------------

let tabs = [
  { name: "multiply", content: TAB_MULTIPLY },
  { name: "addbc", content: TAB_ADDBC },
];
let activeIndex = 0;
let untitledCount = 0;

const sourceEl = $("source");

function renderTabs() {
  const bar = $("tabbar");
  bar.innerHTML = "";
  tabs.forEach((tab, i) => {
    const el = document.createElement("div");
    el.className = "tab" + (i === activeIndex ? " active" : "");

    const name = document.createElement("input");
    name.className = "name";
    name.value = tab.name;
    name.size = Math.max(tab.name.length, 4);
    name.addEventListener("focus", () => { if (activeIndex !== i) selectTab(i); });
    name.addEventListener("input", () => {
      tab.name = name.value;
      name.size = Math.max(name.value.length, 4);
      scheduleRefresh();
    });
    el.appendChild(name);

    if (tabs.length > 1) {
      const close = document.createElement("button");
      close.className = "close";
      close.textContent = "×";
      close.title = "Close tab";
      close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(i); });
      el.appendChild(close);
    }

    el.addEventListener("click", (e) => {
      if (e.target !== name && activeIndex !== i) selectTab(i);
    });
    bar.appendChild(el);
  });

  const add = document.createElement("button");
  add.className = "tab-add";
  add.textContent = "+ tab";
  add.addEventListener("click", addTab);
  bar.appendChild(add);
}

function selectTab(i) {
  // textarea content is kept live on input, so just switch.
  activeIndex = i;
  sourceEl.value = tabs[i].content;
  renderTabs();
}

function addTab() {
  untitledCount++;
  tabs.push({ name: `func${untitledCount}`, content: "; new function\n        .org    0x8200\n" });
  selectTab(tabs.length - 1);
  scheduleRefresh();
}

function closeTab(i) {
  tabs.splice(i, 1);
  if (activeIndex >= tabs.length) activeIndex = tabs.length - 1;
  selectTab(activeIndex);
  scheduleRefresh();
}

const DROP_EXT = /\.(asm|inc|txt|s|z80)$/i;

/** Open dropped source files, each in its own tab. */
async function openFiles(fileList) {
  const files = [...fileList].filter((f) => DROP_EXT.test(f.name));
  if (files.length === 0) {
    const status = $("status");
    status.textContent = "Only .asm / .inc / .txt files can be dropped here.";
    status.className = "status bad";
    return;
  }
  for (const f of files) {
    let text;
    try {
      text = await f.text();
    } catch {
      continue;
    }
    const name = f.name.replace(/\.[^.]+$/, "") || f.name;
    tabs.push({ name, content: text });
  }
  activeIndex = tabs.length - 1;
  selectTab(activeIndex);
  scheduleRefresh();
}

sourceEl.addEventListener("input", () => {
  tabs[activeIndex].content = sourceEl.value;
  scheduleRefresh();
});

// Keep the start-label dropdown current by quietly compiling in the background.
// This only updates the labels + listing; it never touches run results or status.
let refreshTimer;
async function refreshLabels() {
  const { source, offsets } = buildCombined();
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source, compileOnly: true, assembler: $("assembler").value }),
    });
    const data = await res.json();
    populateLabels(data.symbols);
    if (data.listing) renderListing(data.listing, offsets);
  } catch {
    // Ignore background refresh failures; Run/Compile surface real errors.
  }
}
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshLabels, 500);
}

/** Concatenate all tabs and track each tab's starting (0-based) line. */
function buildCombined() {
  const parts = [];
  const offsets = [];
  let line = 0;
  for (const tab of tabs) {
    const numLines = tab.content.split("\n").length;
    offsets.push({ name: tab.name, start: line, lines: numLines });
    parts.push(tab.content);
    line += numLines;
  }
  return { source: parts.join("\n"), offsets };
}

function mapLine(globalLine, offsets) {
  if (globalLine == null) return "?";
  for (const o of offsets) {
    if (globalLine >= o.start && globalLine < o.start + o.lines) {
      return `${o.name}:${globalLine - o.start + 1}`;
    }
  }
  return `line ${globalLine + 1}`;
}

// ---- Helpers -----------------------------------------------------------------

function parseNumber(text) {
  const t = String(text).trim().toLowerCase();
  if (t === "") return undefined;
  if (t.startsWith("0x")) return parseInt(t.slice(2), 16);
  if (t.startsWith("$")) return parseInt(t.slice(1), 16);
  const n = Number(t);
  return Number.isNaN(n) ? undefined : n;
}

const hex = (v, w) => (v >>> 0).toString(16).toUpperCase().padStart(w, "0");

function parseRegs(text) {
  const regs = {};
  for (const tok of text.split(/[\s,]+/).filter(Boolean)) {
    const [name, val] = tok.split("=");
    const key = name?.toLowerCase();
    const num = parseNumber(val);
    if (REG_NAMES.includes(key) && num !== undefined) regs[key] = num;
  }
  return regs;
}

function parseDumps(text) {
  const dumps = [];
  for (const tok of text.split(/[\s,]+/).filter(Boolean)) {
    const [start, len] = tok.split(":");
    const s = parseNumber(start);
    if (s !== undefined) dumps.push({ start: s, length: parseNumber(len) ?? 16 });
  }
  return dumps;
}

function parsePorts(text) {
  const ports = [];
  for (const tok of text.split(/[\s,]+/).filter(Boolean)) {
    const p = parseNumber(tok);
    if (p !== undefined) ports.push(p & 0xff);
  }
  return ports;
}

// ---- Rendering ---------------------------------------------------------------

function populateLabels(symbols) {
  const sel = $("startLabel");
  const previous = sel.value;
  sel.innerHTML = '<option value="">(auto / first code)</option>';
  for (const s of symbols ?? []) {
    const opt = document.createElement("option");
    opt.value = s.name;
    opt.textContent = `${s.name}  (${hex(s.value, 4)})`;
    sel.appendChild(opt);
  }
  // Keep the previous choice if it still exists.
  if ([...sel.options].some((o) => o.value === previous)) sel.value = previous;
}

const REG_LAYOUT = [
  ["AF", "af", 4], ["BC", "bc", 4], ["DE", "de", 4], ["HL", "hl", 4],
  ["AF'", "afPrime", 4], ["BC'", "bcPrime", 4], ["DE'", "dePrime", 4], ["HL'", "hlPrime", 4],
  ["IX", "ix", 4], ["IY", "iy", 4], ["SP", "sp", 4], ["PC", "pc", 4],
];

const EMPTY_SNAP = Object.fromEntries(REG_LAYOUT.map(([, key]) => [key, 0]));

/** Render the register pairs in hex, marking ones that differ from `initial`. */
function renderRegisters(current, initial) {
  $("regsOut").innerHTML = REG_LAYOUT
    .map(([label, key, w]) => {
      const v = current[key];
      const changed = initial && v !== initial[key];
      const was = changed ? `<span class="init">was ${hex(initial[key], w)}</span>` : "";
      return `<div class="cell ${changed ? "changed" : ""}">` +
        `<b>${label}</b> ${hex(v, w)}${was}</div>`;
    })
    .join("");
}

function renderFlags(f) {
  const order = ["S", "Z", "H", "P", "N", "C"];
  $("flags").innerHTML = order
    .map((name) => `<span class="flag ${f[name] ? "on" : ""}">${name}</span>`)
    .join("");
}

function renderMemory(dumps) {
  if (!dumps || dumps.length === 0) { $("memory").innerHTML = ""; return; }
  const blocks = dumps.map((d) => {
    const rows = [];
    for (let row = 0; row < d.length; row += 16) {
      const addr = (d.start + row) & 0xffff;
      const cells = [];
      const ascii = [];
      for (let i = 0; i < 16 && row + i < d.length; i++) {
        const b = d.bytes[row + i];
        cells.push(hex(b, 2));
        ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".");
      }
      rows.push(`  ${hex(addr, 4)}  ${cells.join(" ").padEnd(47)}  ${ascii.join("")}`);
    }
    return `Memory ${hex(d.start, 4)}..${hex(d.start + d.length - 1, 4)}:\n${rows.join("\n")}`;
  });
  $("memory").innerHTML = `<pre>${blocks.join("\n\n")}</pre>`;
}

/** Render OUT writes grouped per port, each as a byte stream (hex + ascii). */
function renderPortLog(log) {
  const el = $("portLog");
  if (!log || log.length === 0) {
    el.innerHTML = '<div class="meta">No OUT writes captured. Put a port in ' +
      '"Port dump" (blank = all ports) and run code that uses <code>OUT</code>.</div>';
    return;
  }
  const groups = new Map(); // port -> bytes, in first-seen order
  for (const { port, value } of log) {
    if (!groups.has(port)) groups.set(port, []);
    groups.get(port).push(value);
  }
  const blocks = [];
  for (const [port, vals] of groups) {
    const rows = [];
    for (let i = 0; i < vals.length; i += 16) {
      const cells = [];
      const ascii = [];
      for (let j = 0; j < 16 && i + j < vals.length; j++) {
        const b = vals[i + j];
        cells.push(hex(b, 2));
        ascii.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".");
      }
      rows.push(`  ${cells.join(" ").padEnd(47)}  ${ascii.join("")}`);
    }
    blocks.push(`Port ${hex(port, 2)} — ${vals.length} byte(s):\n${rows.join("\n")}`);
  }
  el.innerHTML = `<pre>${escapeHtml(blocks.join("\n\n"))}</pre>`;
}

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Render the listing as HTML, optionally highlighting the line at `curAddr`. */
function renderListing(listing, offsets, curAddr) {
  let highlighted = false;
  $("listing").innerHTML = listing
    .map((l) => {
      const bytes = l.binary.map((b) => hex(b, 2)).join(" ");
      const loc = mapLine(l.lineNumber, offsets).padStart(14);
      const err = l.error ? `  ; ERROR: ${l.error}` : "";
      const text = escapeHtml(`${loc}  ${hex(l.address, 4)}  ${bytes.padEnd(12)}  ${l.text}${err}`);
      // Highlight the first code line whose address matches the current PC.
      if (!highlighted && curAddr != null && l.binary.length > 0 && l.address === curAddr) {
        highlighted = true;
        return `<span class="cur">${text}</span>`;
      }
      return text;
    })
    .join("\n");
  // Keep the highlighted instruction visible while stepping.
  $("listing").querySelector(".cur")?.scrollIntoView({ block: "nearest" });
}

/** Find the listing line text for a given address (the instruction at PC). */
function instrAt(listing, addr) {
  const l = (listing ?? []).find((x) => x.binary.length > 0 && x.address === addr);
  return l ? l.text.trim() : "";
}

const STOP_LABEL = {
  returned: "function returned (RET to sentinel)",
  halted: "HALT executed",
  "max-instructions": "stopped at instruction cap (possible infinite loop)",
};

const ASM_LABEL = { z80asm: "z80-asm", wla: "WLA-DX" };

// ---- Step debugger state -----------------------------------------------------

// Holds the most recent run so the slider/buttons can scrub through it.
let lastRun = null; // { trace, initial, listing, offsets, dumps }
let stepIndex = 0;

/** Show the register/flag/listing state at a given step of the last run. */
function showStep(index) {
  if (!lastRun || !lastRun.trace) return;
  const trace = lastRun.trace;
  stepIndex = Math.max(0, Math.min(index, trace.length - 1));
  const snap = trace[stepIndex];
  const initial = lastRun.initial.registers;

  renderRegisters(snap.registers, initial);
  renderFlags(snap.flags);
  renderListing(lastRun.listing, lastRun.offsets, snap.pc);

  $("stepSlider").value = String(stepIndex);
  $("stepLabel").textContent = `step ${stepIndex} / ${trace.length - 1}`;
  const instr = instrAt(lastRun.listing, snap.pc);
  $("stepInstr").textContent =
    stepIndex === trace.length - 1
      ? `done @ ${hex(snap.pc, 4)}`
      : `next @ ${hex(snap.pc, 4)}  ${instr}`;
}

function setupStepper(data, offsets) {
  const r = data.result;
  const trace = r.trace;
  lastRun = { trace, initial: r.initial, listing: data.listing, offsets, dumps: data.dumps };

  const stepper = $("stepper");
  if (!trace || trace.length <= 1) {
    stepper.hidden = true;
    // No trace: still show final registers vs initial.
    renderRegisters(r.registers, r.initial.registers);
    renderFlags(r.flags);
    return;
  }
  stepper.hidden = false;
  $("stepSlider").max = String(trace.length - 1);
  showStep(trace.length - 1); // default to the final state
}

// ---- Run / compile -----------------------------------------------------------

async function send(compileOnly) {
  const status = $("status");
  status.textContent = compileOnly ? "Compiling…" : "Running…";
  status.className = "status";

  const { source, offsets } = buildCombined();
  const payload = {
    source,
    compileOnly,
    trace: !compileOnly,
    assembler: $("assembler").value,
    entryLabel: $("startLabel").value || undefined,
    registers: parseRegs($("regs").value),
    dumps: parseDumps($("dump").value),
    ports: parsePorts($("portDump").value),
    sp: parseNumber($("sp").value),
  };

  let data;
  try {
    const res = await fetch("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    data = await res.json();
  } catch (e) {
    status.textContent = "Network error: " + e.message;
    status.className = "status bad";
    return;
  }

  if (data.listing) renderListing(data.listing, offsets);
  populateLabels(data.symbols);

  if (!data.ok) {
    const msg = (data.errors ?? [])
      .map((e) => `${mapLine(e.lineNumber, offsets)}: ${e.message}`)
      .join("; ");
    status.textContent = "Assembly failed";
    status.className = "status bad";
    $("summary").textContent = msg || "No bytes were produced.";
    $("stepper").hidden = true;
    $("regsOut").innerHTML = ""; $("flags").innerHTML = ""; $("memory").innerHTML = "";
    return;
  }

  if (compileOnly) {
    status.textContent = "Compiled";
    status.className = "status good";
    $("summary").innerHTML =
      `Assembled <b>${data.byteCount}</b> bytes &middot; ${(data.symbols ?? []).length} labels. ` +
      `Pick a start label, then Run.`;
    return;
  }

  const r = data.result;
  status.textContent = "Done";
  status.className = "status good";
  const warn = data.warning ? ` &middot; <span style="color:var(--bad)">${data.warning}</span>` : "";
  const trunc = r.traceTruncated ? " &middot; trace truncated at cap" : "";
  $("summary").innerHTML =
    `<b>${ASM_LABEL[data.assembler] ?? data.assembler}</b> &middot; ` +
    `assembled <b>${data.byteCount}</b> bytes &middot; started at <b>${hex(data.usedEntryPoint ?? 0, 4)}</b>` +
    `${$("startLabel").value ? ` (${$("startLabel").value})` : ""}${warn}<br>` +
    `${STOP_LABEL[r.stopReason] ?? r.stopReason} &middot; ` +
    `${r.instructionsExecuted.toLocaleString()} instructions &middot; ${r.tStates.toLocaleString()} T-states${trunc}`;

  setupStepper(data, offsets);
  renderMemory(data.dumps);
  renderPortLog(r.portLog);
}

// ---- Init --------------------------------------------------------------------

function showSubPane(which) {
  const mem = which === "mem";
  $("memPane").hidden = !mem;
  $("portPane").hidden = mem;
  $("memTabBtn").classList.toggle("active", mem);
  $("portTabBtn").classList.toggle("active", !mem);
}

renderTabs();
selectTab(0);
$("regs").value = "b=6 c=7";
$("dump").value = "0x9000:2";
renderRegisters(EMPTY_SNAP, null); // show the register grid populated from the start
renderFlags({ S: false, Z: false, H: false, P: false, N: false, C: false });
renderPortLog(null);
$("memTabBtn").addEventListener("click", () => showSubPane("mem"));
$("portTabBtn").addEventListener("click", () => showSubPane("port"));
$("assembler").addEventListener("change", refreshLabels);

// Drag-and-drop source files onto the editor panel; each opens in a new tab.
const sourcePanel = document.querySelector(".source");
sourcePanel.addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  sourcePanel.classList.add("dragover");
});
sourcePanel.addEventListener("dragleave", (e) => {
  if (e.target === sourcePanel) sourcePanel.classList.remove("dragover");
});
sourcePanel.addEventListener("drop", (e) => {
  e.preventDefault();
  sourcePanel.classList.remove("dragover");
  if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files);
});
refreshLabels(); // populate the start-label list on first load
$("runBtn").addEventListener("click", () => send(false));
$("compileBtn").addEventListener("click", () => send(true));
$("stepSlider").addEventListener("input", (e) => showStep(Number(e.target.value)));
$("stepFirst").addEventListener("click", () => showStep(0));
$("stepPrev").addEventListener("click", () => showStep(stepIndex - 1));
$("stepNext").addEventListener("click", () => showStep(stepIndex + 1));
$("stepLast").addEventListener("click", () => showStep(lastRun?.trace ? lastRun.trace.length - 1 : 0));
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { send(false); return; }
  // Arrow keys step through the trace when not typing in a field.
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName);
  if (!typing && lastRun?.trace) {
    if (e.key === "ArrowRight") { showStep(stepIndex + 1); e.preventDefault(); }
    if (e.key === "ArrowLeft") { showStep(stepIndex - 1); e.preventDefault(); }
  }
});
