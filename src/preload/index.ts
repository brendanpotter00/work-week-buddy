/**
 * The bridge — `docs/IMPL_UI.md` §2.5.
 *
 * The renderer reaches the machine only through this file. It gets two
 * functions and nothing else.
 *
 * NOT exposed, deliberately: `ipcRenderer` itself, `process`, `require`, any
 * `send`/`sendSync`, any path, any database handle. `sendSync` in particular
 * blocks the renderer and there is no case here that needs it.
 *
 * Built as CommonJS. `docs/IMPL_UI.md` §1.10: an ESM preload under
 * `sandbox: true` fails to load with NO renderer error at all — `window.wwb` is
 * simply `undefined` and every IPC call throws "cannot read invoke".
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  INVOKE_CHANNELS,
  PUSH_CHANNELS,
  type InvokeChannel,
  type InvokeContract,
  type PushChannel,
  type PushContract,
} from "../shared/ipc-types";

const invokeSet = new Set<string>(INVOKE_CHANNELS);
const pushSet = new Set<string>(PUSH_CHANNELS);

export interface WwbBridge {
  invoke<K extends InvokeChannel>(
    channel: K,
    payload: InvokeContract[K]["req"],
  ): Promise<InvokeContract[K]["res"]>;

  /** Returns an unsubscribe function. Always call it from a useEffect cleanup. */
  on<K extends PushChannel>(channel: K, cb: (payload: PushContract[K]) => void): () => void;
}

/**
 * The allowlist is enforced HERE as well as in main, because this is the layer
 * that catches a handler wired up without a contract entry — the one mistake
 * that would otherwise compile, run, and quietly widen the bridge.
 */
export function createBridge(rpc: {
  invoke: (channel: string, payload: unknown) => Promise<unknown>;
  on: (channel: string, listener: (e: unknown, payload: unknown) => void) => void;
  removeListener: (channel: string, listener: (e: unknown, payload: unknown) => void) => void;
}): WwbBridge {
  return {
    invoke(channel, payload) {
      if (!invokeSet.has(channel)) {
        return Promise.reject(new Error(`blocked invoke channel: ${String(channel)}`));
      }
      return rpc.invoke(channel, payload) as Promise<never>;
    },

    on(channel, cb) {
      if (!pushSet.has(channel)) throw new Error(`blocked push channel: ${String(channel)}`);
      // Strip the IpcRendererEvent: it carries `sender`, which is a capability
      // we do not hand to page code.
      const listener = (_e: unknown, payload: unknown): void => cb(payload as never);
      rpc.on(channel, listener);
      return () => {
        rpc.removeListener(channel, listener);
      };
    },
  };
}

/* c8 ignore start — runs only inside a real preload context */
if (typeof contextBridge?.exposeInMainWorld === "function") {
  contextBridge.exposeInMainWorld(
    "wwb",
    createBridge({
      invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
      on: (channel, listener) => {
        ipcRenderer.on(channel, listener as never);
      },
      removeListener: (channel, listener) => {
        ipcRenderer.removeListener(channel, listener as never);
      },
    }),
  );
}
/* c8 ignore stop */
