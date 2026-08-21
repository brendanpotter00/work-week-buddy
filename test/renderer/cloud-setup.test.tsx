// @vitest-environment jsdom
/**
 * The cloud setup wizard, against a stubbed bridge.
 *
 * What is worth proving here is not that it renders. It is:
 *
 *  1. THE API TOKEN NEVER LEAVES THE FIELD. Not into React state, not into an
 *     attribute, not into what the pane renders back, not into any IPC payload
 *     other than the two it belongs in. Same rule and same reasoning as the
 *     sync token in `test/renderer/settings.test.tsx`.
 *  2. PASTING DOES NOT START ANYTHING. The first thing a token does is a
 *     read-only probe, and the account is live: a wizard that began creating on
 *     paste would be a second `wwb` database on the wrong account.
 *  3. The slot is shown, and only asked about when the evidence cannot decide.
 *     Getting it wrong is silent and permanent, so the screen has to say what
 *     it concluded and why, whichever it did.
 *  4. The other Mac's token is shown ONCE, with the warning, and only when one
 *     was actually minted.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";

import { CloudSetupWizard } from "@/renderer/components/cloud-setup-wizard";
import type {
  CloudProbeRequest,
  CloudProbeResult,
  CloudSetupResult,
  CloudSetupRunRequest,
  CloudSlotVerdict,
  CloudStep,
  CloudStepId,
} from "@/shared/ipc-types";
import { installBridge, installDomStubs, makeBridge, renderApp, type StubBridge } from "./harness";

/** Shaped like a real Cloudflare API token, so a substring search cannot pass by luck. */
const API_TOKEN = "V1lLNMKcJ9_Yz8Q3rTfB2wXpA6nE0dH4sG7uK1oM";
const OTHER_TOKEN = "b3JoZXItbWFjLXRva2VuLW5vdC1hLXJlYWwtb25lPT0=";

const ACCOUNT = { id: "00000000000000000000000000000001", name: "Personal" };

function steps(state: CloudStep["state"] = "done"): CloudStep[] {
  const ids: CloudStepId[] = [
    "token",
    "account",
    "database",
    "schema",
    "deploy",
    "url",
    "verify",
    "save",
  ];
  return ids.map((id) => ({ id, label: id, state, detail: null }));
}

function probeResult(over: Partial<CloudProbeResult> = {}): CloudProbeResult {
  return {
    tokenValid: true,
    tokenStatus: "active",
    accounts: [ACCOUNT],
    deployment: {
      accountId: ACCOUNT.id,
      databaseExists: false,
      workerExists: false,
      verdict: { kind: "assumed", slot: "personal", because: "nothing is deployed yet." },
      slotsWithToken: [],
      accountSubdomain: "someones-subdomain",
      rowsInCloud: null,
    },
    error: null,
    ...over,
  };
}

function runResult(over: Partial<CloudSetupResult> = {}): CloudSetupResult {
  return {
    steps: steps(),
    done: true,
    error: null,
    ok: true,
    workerUrl: "https://wwb-sync.someones-subdomain.workers.dev",
    slot: "personal",
    otherSlot: "work",
    otherMachineToken: OTHER_TOKEN,
    unstoredToken: null,
    ...over,
  };
}

interface Fixture {
  bridge: StubBridge;
  /** Every probe payload, in order. The API token is only ever here and in runs. */
  probes: CloudProbeRequest[];
  runs: CloudSetupRunRequest[];
  container: HTMLElement;
  finished: number;
}

function mount(
  over: { probe?: CloudProbeResult; run?: CloudSetupResult } = {},
): Fixture {
  const probes: CloudProbeRequest[] = [];
  const runs: CloudSetupRunRequest[] = [];
  const fixture = { finished: 0 } as Fixture;
  const bridge = makeBridge({
    "wwb:cloud:probe": (req) => {
      probes.push(req);
      return over.probe ?? probeResult();
    },
    "wwb:cloud:run": (req) => {
      runs.push(req);
      return over.run ?? runResult();
    },
  });
  installBridge(bridge);
  const { container } = renderApp(
    <CloudSetupWizard
      onFinished={() => {
        fixture.finished += 1;
      }}
    />,
  );
  return Object.assign(fixture, { bridge, probes, runs, container });
}

function panel(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-slot="cloud-setup"]');
  if (el === null) throw new Error("the wizard did not render");
  return el;
}

function open(): void {
  fireEvent.click(screen.getByRole("button", { name: /set up cloud sync/i }));
}

/** The "Set it up" button, typed, so `disabled` can actually be read. */
function goButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /set it up/i }) as HTMLButtonElement;
}

function typeToken(value = API_TOKEN): HTMLInputElement {
  const input = screen.getByLabelText(/cloudflare api token/i) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
}

beforeEach(() => {
  installDomStubs();
  installBridge(undefined);
});

describe("nothing happens until it is asked to", () => {
  it("starts closed, offering only a button", () => {
    const f = mount();
    expect(panel(f.container).dataset["phase"]).toBe("closed");
    expect(f.probes).toEqual([]);
  });

  it("does not probe merely because a token was typed", () => {
    const f = mount();
    open();
    typeToken();
    // Pasting must not reach the network: the next screen is a confirmation,
    // and confirming after the fact is not confirming.
    expect(f.probes).toEqual([]);
  });

  it("probes — and changes nothing — when the token is checked", async () => {
    const f = mount();
    open();
    typeToken();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check the token/i }));
    });

    expect(f.probes).toEqual([{ apiToken: API_TOKEN }]);
    // No run was started. `wwb:cloud:probe` is the only channel that has been
    // touched, and it is the read-only one.
    expect(f.runs).toEqual([]);
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("confirm"));
  });
});

describe("the API token never leaves the field", () => {
  it("is absent from the DOM, from every attribute, and from every other payload", async () => {
    const f = mount();
    open();
    const input = typeToken();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check the token/i }));
    });
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("confirm"));

    // In the DOM node's `.value` and nowhere else in the tree.
    expect(input.value).toBe(API_TOKEN);
    expect(f.container.innerHTML).not.toContain(API_TOKEN);
    for (const el of f.container.querySelectorAll("*")) {
      for (const attr of el.attributes) {
        expect(attr.value).not.toContain(API_TOKEN);
      }
    }
    // It rides on the probe, and on nothing else.
    const others = f.bridge.calls.filter((c) => c.channel !== "wwb:cloud:probe");
    expect(JSON.stringify(others)).not.toContain(API_TOKEN);
  });

  it("is an unbound password field, so nothing autofills or restores it", () => {
    mount();
    open();
    const input = typeToken();
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    // UNCONTROLLED: React never wrote a `value` attribute, only the property.
    expect(input.getAttribute("value")).toBeNull();
  });

  it("is blanked the moment the run resolves", async () => {
    const f = mount();
    await runToDone(f);
    const input = screen.queryByLabelText(/cloudflare api token/i);
    // The field is gone with its step, and the value went with it.
    expect(input).toBeNull();
    expect(f.container.innerHTML).not.toContain(API_TOKEN);
  });
});

async function runToDone(f: Fixture): Promise<void> {
  open();
  typeToken();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /check the token/i }));
  });
  await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("confirm"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /set it up/i }));
  });
  await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("done"));
}

describe("the slot", () => {
  async function confirmWith(verdict: CloudSlotVerdict): Promise<Fixture> {
    const f = mount({
      probe: probeResult({
        deployment: { ...probeResult().deployment!, verdict },
      }),
    });
    open();
    typeToken();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check the token/i }));
    });
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("confirm"));
    return f;
  }

  it("is stated, with its reasoning, when it was decided", async () => {
    const f = await confirmWith({
      kind: "certain",
      slot: "work",
      because: "the personal slot is registered to a different Mac, so this one takes work.",
    });
    const verdict = f.container.querySelector<HTMLElement>('[data-slot="slot-verdict"]');
    expect(verdict?.dataset["kind"]).toBe("certain");
    expect(verdict?.textContent).toContain("work Mac");
    expect(verdict?.textContent).toContain("registered to a different Mac");
    // No picker: it was not a question.
    expect(f.container.querySelector('[data-slot="slot-picker"]')).toBeNull();
  });

  it("always warns what getting it wrong costs, even when it is certain", async () => {
    const f = await confirmWith({
      kind: "certain",
      slot: "personal",
      because: "this Mac's hardware UUID is already set as MACHINE_ID_PERSONAL.",
    });
    const text = f.container.querySelector('[data-slot="slot-verdict"]')?.textContent ?? "";
    // The failure is silent — no error, correct totals, wrong attribution — so
    // the screen has to be the thing that says so.
    expect(text).toContain("does not fail");
    expect(text).toContain("permanently");
  });

  it("asks, and blocks the run, when the evidence cannot decide", async () => {
    const f = await confirmWith({
      kind: "ask",
      suggested: null,
      because: "both slots already have a machine id.",
    });
    expect(f.container.querySelector('[data-slot="slot-picker"]')).not.toBeNull();
    expect(goButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: /this is my work mac/i }));
    await waitFor(() => expect(goButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /set it up/i }));
    });
    expect(f.runs[0]?.slot).toBe("work");
  });

  it("pre-selects a suggestion but still asks", async () => {
    const f = await confirmWith({
      kind: "ask",
      suggested: "work",
      because: "this Mac has never synced.",
    });
    // Pre-selected, so the run is not blocked — but the picker is on screen and
    // the reasoning is beside it.
    expect(goButton().disabled).toBe(false);
    expect(f.container.querySelector('[data-slot="slot-picker"]')).not.toBeNull();
  });
});

describe("what setup says it will do", () => {
  it("says ADOPT, with the row count, when a database already exists", async () => {
    const f = mount({
      probe: probeResult({
        deployment: {
          ...probeResult().deployment!,
          databaseExists: true,
          workerExists: true,
          rowsInCloud: 4812,
          slotsWithToken: ["work"],
        },
      }),
    });
    open();
    typeToken();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check the token/i }));
    });
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("confirm"));

    const plan = f.container.querySelector('[data-slot="cloud-plan"]')?.textContent ?? "";
    expect(plan).toContain("Adopt");
    expect(plan).toContain("4812");
    expect(plan).toContain("Redeploy");
    expect(plan).toContain("Leave the other Mac");
  });

  it("offers to replace the other Mac's token only when it has one, and off by default", async () => {
    const f = mount({
      probe: probeResult({
        deployment: { ...probeResult().deployment!, slotsWithToken: ["work"] },
      }),
    });
    open();
    typeToken();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check the token/i }));
    });
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("confirm"));

    const rotate = f.container.querySelector<HTMLInputElement>('[data-slot="rotate-other"]');
    expect(rotate).not.toBeNull();
    expect(rotate?.checked).toBe(false);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /set it up/i }));
    });
    // Absent, not false: a re-run must never reset the other Mac's token.
    expect(f.runs[0]?.rotateOtherToken).toBeUndefined();
  });

  it("does not promise a token it will not mint while the slot is unchosen", async () => {
    // Both slots hold a token, and the verdict cannot decide which Mac this is.
    // Whichever slot is picked, the other one is left alone — so the plan must
    // not say "mint a token for the other Mac" before there IS an other Mac.
    const f = mount({
      probe: probeResult({
        deployment: {
          ...probeResult().deployment!,
          workerExists: true,
          databaseExists: true,
          slotsWithToken: ["personal", "work"],
          verdict: { kind: "ask", suggested: null, because: "both slots have a machine id." },
        },
      }),
    });
    open();
    typeToken();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check the token/i }));
    });
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("confirm"));

    const plan = () => f.container.querySelector('[data-slot="cloud-plan"]')?.textContent ?? "";
    expect(plan()).not.toContain("Mint a token");
    expect(plan()).toContain("Choose which Mac this is");

    // Once a slot is picked, the plan becomes specific — and correct.
    fireEvent.click(screen.getByRole("button", { name: /this is my work mac/i }));
    await waitFor(() => expect(plan()).toContain("Leave the other Mac"));
    expect(plan()).not.toContain("Mint a token");
  });

  it("asks for a workers.dev subdomain only when the account has none", async () => {
    const f = mount({
      probe: probeResult({
        deployment: { ...probeResult().deployment!, accountSubdomain: null },
      }),
    });
    open();
    typeToken();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /check the token/i }));
    });
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("confirm"));

    const field = screen.getByLabelText(/workers.dev subdomain/i);
    // Account-wide and permanent in practice: the run is blocked until it is
    // answered rather than defaulted.
    expect(goButton().disabled).toBe(true);
    fireEvent.change(field, { target: { value: "chosen-name" } });
    await waitFor(() => expect(goButton().disabled).toBe(false));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /set it up/i }));
    });
    expect(f.runs[0]?.subdomain).toBe("chosen-name");
  });
});

describe("the other Mac's token, shown once", () => {
  it("is displayed with a warning that it cannot be recovered", async () => {
    const f = mount();
    await runToDone(f);

    const reveal = f.container.querySelector('[data-slot="token-reveal"]');
    expect(reveal).not.toBeNull();
    expect(
      f.container.querySelector('[data-slot="token-value"]')?.textContent,
    ).toBe(OTHER_TOKEN);
    const text = reveal?.textContent ?? "";
    expect(text).toContain("only time it will ever be shown");
    expect(text).toContain("work Mac");
    // Rendered as element text, not as an input's value — nothing autofills a
    // <code>, and it is not an attribute anywhere.
    expect(
      f.container.querySelector<HTMLElement>('[data-slot="token-value"]')?.tagName,
    ).toBe("CODE");
  });

  it("shows nothing when the other Mac's token was left alone", async () => {
    const f = mount({ run: runResult({ otherMachineToken: null }) });
    await runToDone(f);
    expect(f.container.querySelector('[data-slot="token-reveal"]')).toBeNull();
    expect(f.container.textContent).toContain("Sync is on");
  });

  it("hands over THIS Mac's token when the keychain refused it", async () => {
    const f = mount({
      run: runResult({
        ok: false,
        otherMachineToken: null,
        unstoredToken: "this-macs-token-that-could-not-be-stored",
        error: "this system has no available safeStorage backend",
      }),
    });
    await runToDone(f);
    // The cloud half is real; reporting a flat failure would send someone to
    // re-run a deployment that is already correct.
    expect(f.container.querySelector('[data-slot="token-value"]')?.textContent).toBe(
      "this-macs-token-that-could-not-be-stored",
    );
    expect(f.container.textContent).toContain("keychain would not store");
  });

  it("tells the sync card to reload, so it stops saying “not set up”", async () => {
    const f = mount();
    await runToDone(f);
    expect(f.finished).toBe(1);
  });

  it("drops the shown token from the tree when the wizard is closed", async () => {
    const f = mount();
    await runToDone(f);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^done$/i }));
    });
    expect(panel(f.container).dataset["phase"]).toBe("closed");
    expect(f.container.innerHTML).not.toContain(OTHER_TOKEN);
  });
});

describe("progress", () => {
  it("renders every step, with the failed one marked", async () => {
    const failed = steps("pending");
    failed[0] = { id: "token", label: "Check the API token", state: "done", detail: "accepted" };
    failed[1] = {
      id: "account",
      label: "Find the Cloudflare account",
      state: "failed",
      detail: "missing permission",
    };
    const f = mount({ run: runResult({ ok: false, done: false, steps: failed, error: "nope" }) });
    await runToDone(f);

    const rows = f.container.querySelectorAll('[data-slot="cloud-steps"] li');
    expect(rows).toHaveLength(8);
    expect(
      f.container.querySelector<HTMLElement>('[data-step="account"]')?.dataset["state"],
    ).toBe("failed");
    expect(f.container.textContent).toContain("missing permission");
  });

  it("surfaces the reason a run stopped", async () => {
    const f = mount({
      run: runResult({ ok: false, done: false, error: "The API token is missing the “D1: Edit” permission" }),
    });
    await runToDone(f);
    expect(f.container.textContent).toContain("D1: Edit");
  });
});
