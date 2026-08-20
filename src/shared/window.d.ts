import type { WwbBridge } from "../preload";

declare global {
  interface Window {
    wwb: WwbBridge;
  }
}

export {};
