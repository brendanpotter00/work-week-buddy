import { contextBridge } from "electron";

/**
 * The renderer reaches the machine only through this bridge. It never imports
 * electron, never touches the database, and has no node access.
 */
contextBridge.exposeInMainWorld("wwb", {
  version: () => process.versions.electron,
});
