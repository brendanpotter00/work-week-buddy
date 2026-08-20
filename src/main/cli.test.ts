import { describe, expect, it } from "vitest";
import { isUtilityMode, readCliMode } from "./cli";

describe("readCliMode", () => {
  it("maps every flag", () => {
    expect(readCliMode(["node", "app", "--selftest"])).toEqual({ kind: "selftest" });
    expect(readCliMode(["--doctor"])).toEqual({ kind: "doctor" });
    expect(readCliMode(["--install-launch-agent"])).toEqual({ kind: "install-launch-agent" });
    expect(readCliMode(["--uninstall-launch-agent"])).toEqual({ kind: "uninstall-launch-agent" });
    expect(readCliMode(["--hidden"])).toEqual({ kind: "normal", hidden: true });
  });

  it("treats an unknown flag as a normal launch", () => {
    // Electron and macOS both append their own flags. An unknown flag must
    // never be an error, or the LaunchAgent stops working after an OS update.
    expect(readCliMode(["--no-sandbox", "-psn_0_12345"])).toEqual({
      kind: "normal",
      hidden: false,
    });
    expect(readCliMode([])).toEqual({ kind: "normal", hidden: false });
  });

  it("--selftest wins over --hidden, because it is the install gate", () => {
    expect(readCliMode(["--hidden", "--selftest"])).toEqual({ kind: "selftest" });
  });

  it("every utility mode skips the single-instance lock", () => {
    // They run BESIDE a live instance; taking the lock would either exit them
    // immediately or kick the running app off the database.
    for (const argv of [["--selftest"], ["--doctor"], ["--install-launch-agent"]]) {
      expect(isUtilityMode(readCliMode(argv))).toBe(true);
    }
    expect(isUtilityMode(readCliMode(["--hidden"]))).toBe(false);
  });
});
