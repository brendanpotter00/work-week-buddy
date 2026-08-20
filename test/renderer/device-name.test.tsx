// @vitest-environment jsdom
/**
 * The rename field.
 *
 * Against the stubbed bridge, like everything else in this directory: the name
 * on screen has to have arrived over `wwb:app:info`, and the rename has to
 * leave over `wwb:machine:rename`. A field that rendered its own idea of the
 * machine's name would pass a screenshot and fail on the owner's Mac.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { App } from "@/renderer/App";
import { DeviceName } from "@/renderer/components/device-name";
import type { AppInfo } from "@/shared/ipc-types";
import {
  appInfo,
  defaultHandlers,
  installBridge,
  installDomStubs,
  makeBridge,
  metricsBundle,
  renderApp,
} from "./harness";

beforeEach(() => {
  installDomStubs();
  installBridge(undefined);
});

function field(): HTMLInputElement {
  return screen.getByLabelText("This Mac’s name") as HTMLInputElement;
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /Save/ }) as HTMLButtonElement;
}

/** A bridge whose `machine:rename` behaves the way main's handler does. */
function renamingBridge(over: Partial<AppInfo> = {}) {
  const renames: string[] = [];
  let label = over.machineLabel ?? "MacBook Pro";
  const bridge = makeBridge({
    "wwb:app:info": () => appInfo({ ...over, machineLabel: label }),
    "wwb:machine:rename": ({ label: raw }) => {
      renames.push(raw);
      const next = raw.trim().slice(0, 60).trim();
      if (next === "") throw new Error("a device name cannot be empty");
      label = next;
      return appInfo({ ...over, machineLabel: label });
    },
  });
  return { bridge, renames, current: () => label };
}

describe("the rename field", () => {
  it("shows the name main reports, not one of its own", async () => {
    const { bridge } = renamingBridge({ machineLabel: "The loft mini" });
    installBridge(bridge);

    renderApp(<DeviceName />);

    await waitFor(() => expect(field().value).toBe("The loft mini"));
    // Never a blank field on a machine that has a name — that reads as data
    // that failed to load.
    expect(field().value).not.toBe("");
  });

  it("sends the trimmed name and takes main's answer back", async () => {
    const { bridge, renames, current } = renamingBridge();
    installBridge(bridge);

    renderApp(<DeviceName />);
    await waitFor(() => expect(field().value).toBe("MacBook Pro"));

    fireEvent.change(field(), { target: { value: "  The loft mini  " } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(current()).toBe("The loft mini"));
    expect(renames).toEqual(["The loft mini"]);
    // Main trims and caps, so what comes back is what is stored — and the field
    // must show THAT rather than what was typed.
    await waitFor(() => expect(field().value).toBe("The loft mini"));
    await screen.findByText(/Every hour recorded here now shows this name/);
  });

  it("shows the truncation instead of pretending the long name was kept", async () => {
    const { bridge } = renamingBridge();
    installBridge(bridge);

    renderApp(<DeviceName />);
    await waitFor(() => expect(field().value).toBe("MacBook Pro"));

    fireEvent.change(field(), { target: { value: "y".repeat(200) } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(field().value).toBe("y".repeat(60)));
  });

  it("will not send a blank name, and says why", async () => {
    const { bridge, renames } = renamingBridge();
    installBridge(bridge);

    renderApp(<DeviceName />);
    await waitFor(() => expect(field().value).toBe("MacBook Pro"));

    fireEvent.change(field(), { target: { value: "   " } });

    await screen.findByText("A name cannot be empty.");
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(renames).toEqual([]);
  });

  it("stays disabled until something actually changed", async () => {
    const { bridge } = renamingBridge();
    installBridge(bridge);

    renderApp(<DeviceName />);
    await waitFor(() => expect(field().value).toBe("MacBook Pro"));
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(field(), { target: { value: "The loft mini" } });
    expect(saveButton().disabled).toBe(false);
  });

  it("reports a rejected rename rather than looking like it worked", async () => {
    const bridge = makeBridge({
      "wwb:app:info": () => appInfo({ machineLabel: "MacBook Pro" }),
      "wwb:machine:rename": () => {
        throw new Error("EROFS: read-only file system");
      },
    });
    installBridge(bridge);

    renderApp(<DeviceName />);
    await waitFor(() => expect(field().value).toBe("MacBook Pro"));

    fireEvent.change(field(), { target: { value: "The loft mini" } });
    fireEvent.click(saveButton());

    // Announced, not merely drawn: a failed write that renders as a quiet
    // no-op is the silent failure this project treats as a defect.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/read-only file system/);
  });

  it("is reachable from the dashboard", async () => {
    const bridge = makeBridge({
      ...defaultHandlers(metricsBundle()),
      "wwb:machine:rename": () => appInfo({ machineLabel: "The loft mini" }),
    });
    installBridge(bridge);

    renderApp(<App />);

    // The whole point of the feature: somewhere the owner can actually type.
    await waitFor(() => expect(field().value).toBe("Work laptop"));
  });
});
