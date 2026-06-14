import { Z80 } from "z80-emulator";
import type { Hal } from "z80-emulator";
import type { PortWrite } from "./types.js";

const PORT_LOG_CAP = 65536;

/**
 * A minimal flat 64KB machine: full RAM, passive ports.
 * Implements the emulator's hardware abstraction layer.
 */
export class FlatMachine implements Hal {
  tStateCount = 0;
  readonly memory = new Uint8Array(0x10000);
  /** Ports default to 0xff (open bus), the common idle value. */
  private readonly ports = new Uint8Array(0x100).fill(0xff);

  /** OUT writes captured in execution order. */
  readonly portLog: PortWrite[] = [];
  /** Ports to log, or null to log every port. */
  private readonly logPorts: Set<number> | null;

  readonly cpu: Z80;

  constructor(logPorts?: number[]) {
    this.logPorts = logPorts && logPorts.length > 0
      ? new Set(logPorts.map((p) => p & 0xff))
      : null;
    this.cpu = new Z80(this);
    this.cpu.reset();
  }

  readMemory(address: number): number {
    return this.memory[address & 0xffff];
  }

  writeMemory(address: number, value: number): void {
    this.memory[address & 0xffff] = value & 0xff;
  }

  contendMemory(_address: number): void {
    // No memory contention in this simple model.
  }

  readPort(address: number): number {
    return this.ports[address & 0xff];
  }

  writePort(address: number, value: number): void {
    const port = address & 0xff;
    const byte = value & 0xff;
    if ((this.logPorts === null || this.logPorts.has(port)) && this.portLog.length < PORT_LOG_CAP) {
      this.portLog.push({ port, value: byte });
    }
    this.ports[port] = byte;
  }

  contendPort(_address: number): void {
    // No port contention in this simple model.
  }

  /** Load a sparse set of bytes (address -> value) into memory. */
  loadBytes(bytes: Map<number, number>): void {
    for (const [address, value] of bytes) {
      this.memory[address & 0xffff] = value & 0xff;
    }
  }
}
