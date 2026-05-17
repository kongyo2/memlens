import type { MemlensApi } from "@shared/api/contract.ts";

declare global {
  interface Window {
    readonly memlens: MemlensApi;
  }
}

export {};
