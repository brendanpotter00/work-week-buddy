// @vitest-environment jsdom
/**
 * The cloud-setup wizard window, against a stubbed bridge.
 *
 * What is worth proving here is not that it renders. It is:
 *
 *  1. THE API TOKEN NEVER LEAVES THE FIELD. Not into React state, not into an
 *     attribute, not into what the window renders back, not into any IPC
 *     payload other than the two it belongs in. Same rule and same reasoning as
 *     the sync token in `test/renderer/settings.test.tsx`.
 *  2. PASTING DOES NOT START ANYTHING. The first thing a token does is a
 *     read-only probe, and the account is live: a wizard that began creating on
 *     paste would be a second `wwb` database on the wrong account.
 *  3. A MISSING PERMISSION IS NAMED AS A MISSING PERMISSION. This is the
 *     regression test for the failure that cost an evening — he was told the
 *     token was not accepted, so he re-copied a perfectly good token.
 *  4. NOTHING ASKS WHICH MAC THIS IS. Each install enrols itself, so the whole
 *     slot question — and the screen it needed — is gone.
 *  5. This Mac's token is shown ONCE, and only when the keychain refused it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";

import { CloudSetup } from "@/renderer/CloudSetup";
import type {
  CloudProbeRequest,
  CloudProbeResult,
  CloudRevokeRequest,
  CloudRevokeResult,
  CloudSetupResult,
  CloudSetupRunRequest,
  CloudStep,
  CloudStepId,
  EnrolledMachine,
} from "@/shared/ipc-types";
import {
  appInfo,
  installBridge,
  installDomStubs,
  makeBridge,
  renderApp,
  syncConfigState,
  type StubBridge,
} from "./harness";

/** Shaped like a real Cloudflare API token, so a substring search cannot pass by luck. */
const API_TOKEN = "V1lLNMKcJ9_Yz8Q3rTfB2wXpA6nE0dH4sG7uK1oM";

const ACCOUNT = { id: "00000000000000000000000000000001", name: "Personal" };
const THIS_MAC = "00000000-0000-0000-0000-00000000AAAA";
const OTHER_MAC = "00000000-0000-0000-0000-00000000BBBB";

function steps(state: CloudStep["state"] = "done"): CloudStep[] {
  const ids: CloudStepId[] = [
    "token",
    "account",
    "database",
    "schema",
    "enrol",
    "deploy",
    "url",
    "verify",
    "save",
  ];
  return ids.map((id) => ({ id, label: id, state, detail: null }));
}

function machine(over: Partial<EnrolledMachine> = {}): EnrolledMachine {
  return {
    machineId: OTHER_MAC,
    label: "Work MacBook",
    enrolledAtMs: 1_760_000_000_000,
    lastSeenMs: 1_760_000_500_000,
    isThisMac: false,
    ...over,
  };
}

function probeResult(over: Partial<CloudProbeResult> = {}): CloudProbeResult {
  return {
    tokenValid: true,
    tokenStatus: "active",
    accounts: [ACCOUNT],
    scopes: { d1: "ok", workers: "ok", accountRead: "ok" },
    deployment: {
      accountId: ACCOUNT.id,
      databaseExists: false,
      workerExists: false,
      machines: [],
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
    unstoredToken: null,
    ...over,
  };
}

interface Fixture {
  bridge: StubBridge;
  /** Every probe payload, in order. The API token is only ever here and in runs. */
  probes: CloudProbeRequest[];
  runs: CloudSetupRunRequest[];
  revokes: CloudRevokeRequest[];
  tokenPageOpens: number;
  container: HTMLElement;
}

function mount(
  over: {
    probe?: CloudProbeResult;
    run?: CloudSetupResult;
    revoke?: CloudRevokeResult;
    configured?: boolean;
  } = {},
): Fixture {
  const probes: CloudProbeRequest[] = [];
  const runs: CloudSetupRunRequest[] = [];
  const revokes: CloudRevokeRequest[] = [];
  const fixture = { tokenPageOpens: 0 } as Fixture;
  const bridge = makeBridge({
    "wwb:app:info": () => appInfo({ machineLabel: "Brendan’s MacBook Pro", machineId: THIS_MAC }),
    "wwb:sync:config": () =>
      syncConfigState(
        over.configured === true
          ? {
              workerUrl: "https://wwb-sync.someones-subdomain.workers.dev",
              tokenPresent: true,
              configured: true,
            }
          : {},
      ),
    "wwb:cloud:probe": (req) => {
      probes.push(req);
      return over.probe ?? probeResult();
    },
    "wwb:cloud:run": (req) => {
      runs.push(req);
      return over.run ?? runResult();
    },
    "wwb:cloud:revoke": (req) => {
      revokes.push(req);
      return over.revoke ?? { ok: true, machines: [], error: null };
    },
    "wwb:cloud:openTokenPage": () => {
      fixture.tokenPageOpens += 1;
      return undefined;
    },
  });
  installBridge(bridge);
  const { container } = renderApp(<CloudSetup />);
  return Object.assign(fixture, { bridge, probes, runs, revokes, container });
}

function panel(container: HTMLElement): HTMLElement {
  const el = container.querySelector<HTMLElement>('[data-slot="cloud-setup"]');
  if (el === null) throw new Error("the wizard did not render");
  return el;
}

async function toTokenScreen(f: Fixture): Promise<void> {
  await waitFor(() => expect(panel(f.container).dataset["phase"]).not.toBe("loading"));
  if (panel(f.container).dataset["phase"] === "intro") {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /continue/i }));
    });
  }
}

function typeToken(value = API_TOKEN): HTMLInputElement {
  const input = screen.getByLabelText(/cloudflare api token/i) as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
  return input;
}

async function check(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /check the token/i }));
  });
}

/** Paste, check, and land wherever that takes us. */
async function probeWith(f: Fixture): Promise<void> {
  await toTokenScreen(f);
  typeToken();
  await check();
}

async function runToDone(f: Fixture): Promise<void> {
  await probeWith(f);
  await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("review"));
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /set it up/i }));
  });
  await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("done"));
}

beforeEach(() => {
  installDomStubs();
  installBridge(undefined);
});

describe("the window explains itself before it asks for anything", () => {
  it("opens on the intro when nothing is configured", async () => {
    const f = mount();
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("intro"));
    const text = f.container.textContent ?? "";
    expect(text).toContain("second copy");
    expect(text).toContain("free plan");
    // The sentence that replaces the whole slot question.
    expect(text).toContain("no token to carry between machines");
  });

  it("skips the intro for a returning owner", async () => {
    // "Set up again…" is not a first run; it does not need the explanation.
    const f = mount({ configured: true });
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("token"));
  });

  it("renders as its own window view, not inside a card", async () => {
    const f = mount();
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("intro"));
    expect(f.container.querySelector('[data-view="cloud-setup"]')).not.toBeNull();
  });
});

describe("nothing happens until it is asked to", () => {
  it("does not probe merely because a token was typed", async () => {
    const f = mount();
    await toTokenScreen(f);
    typeToken();
    expect(f.probes).toEqual([]);
    expect(f.runs).toEqual([]);
  });

  it("probes — and changes nothing — when the token is checked", async () => {
    const f = mount();
    await probeWith(f);
    await waitFor(() => expect(f.probes).toHaveLength(1));
    expect(f.probes[0]?.apiToken).toBe(API_TOKEN);
    // A probe is read-only. Nothing may have been created.
    expect(f.runs).toEqual([]);
  });
});

describe("the API token never leaves the field", () => {
  it("is absent from the DOM, from every attribute, and from every other payload", async () => {
    const f = mount();
    await probeWith(f);
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("review"));

    expect(f.container.innerHTML).not.toContain(API_TOKEN);
    for (const el of Array.from(f.container.querySelectorAll("*"))) {
      for (const attr of Array.from(el.attributes)) {
        expect(attr.value, `${el.tagName}[${attr.name}]`).not.toContain(API_TOKEN);
      }
    }
    // It rides on the channel it belongs on and nowhere else.
    expect(JSON.stringify(f.probes)).toContain(API_TOKEN);
  });

  it("is an unbound password field, so nothing autofills or restores it", async () => {
    const f = mount();
    await toTokenScreen(f);
    const input = typeToken();
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    // UNCONTROLLED: React never sets `value`, so it is not in a fibre.
    expect(input.getAttribute("value")).toBeNull();
  });

  it("is blanked the moment the run resolves", async () => {
    const f = mount();
    await runToDone(f);
    expect(f.container.innerHTML).not.toContain(API_TOKEN);
  });
});

describe("finding the token page", () => {
  it("says API tokens are under the profile, not on a Worker's page", async () => {
    const f = mount();
    await toTokenScreen(f);
    const text = f.container.textContent ?? "";
    expect(text).toContain("under your profile");
    expect(text).toContain("you are in the wrong place");
  });

  it("opens Cloudflare through main, never through a link", async () => {
    // `lockDownNavigation` preventDefaults any non-app origin on `will-navigate`,
    // so an <a href> here would be inert. It has to be this channel.
    const f = mount();
    await toTokenScreen(f);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /open cloudflare/i }));
    });
    expect(f.tokenPageOpens).toBe(1);
    // And there is no external anchor anywhere for someone to click instead.
    const external = Array.from(f.container.querySelectorAll("a[href]")).filter((a) =>
      (a.getAttribute("href") ?? "").startsWith("http"),
    );
    expect(external).toEqual([]);
  });

  it("lists all three permissions, in the words the dashboard uses", async () => {
    const f = mount();
    await toTokenScreen(f);
    const list = f.container.querySelector('[data-slot="permission-list"]')?.textContent ?? "";
    expect(list).toContain("Account · Workers Scripts · Edit");
    expect(list).toContain("Account · D1 · Edit");
    expect(list).toContain("Account · Account Settings · Read");
    // The checklist is on screen whether or not the deep link works, so a
    // renamed permission key can never leave the reader with no instructions.
    expect(f.container.textContent).toContain("Account Resources");
  });
});

describe("a token that is real but cannot do the job", () => {
  async function withScopes(over: Partial<CloudProbeResult>): Promise<Fixture> {
    const f = mount({ probe: probeResult({ deployment: null, ...over }) });
    await probeWith(f);
    await waitFor(() =>
      expect(f.container.querySelector('[data-slot="scope-problem"]')).not.toBeNull(),
    );
    return f;
  }

  it("names the missing D1 permission and says NOT to make a new token", async () => {
    // THE REGRESSION TEST. He saw "Cloudflare did not accept that API token"
    // and re-copied a token that was perfectly fine.
    const f = await withScopes({
      scopes: { d1: "missing", workers: "ok", accountRead: "ok" },
    });
    const text = f.container.textContent ?? "";
    expect(text).toContain("Account · D1 · Edit");
    expect(text).toContain("That token is real");
    expect(text).toContain("Edit the token you already have rather than making a new one");
    // The wrong words must NOT be on screen.
    expect(text).not.toContain("copied whole");
    expect(text).not.toContain("did not accept that token");
  });

  it("names the missing Workers permission the same way", async () => {
    const f = await withScopes({
      scopes: { d1: "ok", workers: "missing", accountRead: "ok" },
    });
    const text = f.container.textContent ?? "";
    expect(text).toContain("Account · Workers Scripts · Edit");
    expect(text).toContain("deploy Workers");
    expect(text).not.toContain("copied whole");
  });

  it("blames the templates when the token has neither", async () => {
    const f = await withScopes({
      scopes: { d1: "missing", workers: "missing", accountRead: "ok" },
    });
    const text = f.container.textContent ?? "";
    expect(text).toContain("none of the permissions");
    expect(text).toContain("templates");
    expect(text).toContain("Create Custom Token");
  });

  it("creates nothing while a permission is missing", async () => {
    const f = await withScopes({
      scopes: { d1: "missing", workers: "ok", accountRead: "ok" },
    });
    expect(f.runs).toEqual([]);
  });

  it("DOES say 'copied whole' when the token itself was rejected", async () => {
    // The one case that wording is right for, and now the only one it covers.
    const f = mount({
      probe: probeResult({
        tokenValid: false,
        tokenStatus: "unknown",
        scopes: null,
        deployment: null,
        error: "Cloudflare did not accept that API token",
      }),
    });
    await probeWith(f);
    await waitFor(() =>
      expect(f.container.querySelector('[data-slot="scope-problem"]')).not.toBeNull(),
    );
    const text = f.container.textContent ?? "";
    expect(text).toContain("copied whole");
    expect(text).not.toContain("Account · D1 · Edit");
  });
});

describe("wrong-field paste", () => {
  it("warns when the sync token is pasted into the API-token field, and does not probe", async () => {
    const f = mount();
    await toTokenScreen(f);
    // 44 characters of base64 ending in "=" — this Mac's sync token shape.
    typeToken(`${"A".repeat(43)}=`);
    const note = f.container.querySelector('[data-slot="wrong-shape"]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain("this Mac’s sync token");
    expect(note?.textContent).toContain("44 characters");
    // Warned, not blocked — and nothing has been sent anywhere.
    expect(f.probes).toEqual([]);
  });

  it("warns when a URL is pasted in", async () => {
    const f = mount();
    await toTokenScreen(f);
    typeToken("https://wwb-sync.example.workers.dev");
    expect(f.container.querySelector('[data-slot="wrong-shape"]')?.textContent).toContain(
      "That is a URL, not a token",
    );
  });

  it("says nothing about a token of the right shape", async () => {
    const f = mount();
    await toTokenScreen(f);
    typeToken();
    expect(f.container.querySelector('[data-slot="wrong-shape"]')).toBeNull();
  });
});

describe("the review screen", () => {
  function withDeployment(over: Partial<CloudProbeResult["deployment"] & object>) {
    return mount({
      probe: probeResult({
        deployment: {
          accountId: ACCOUNT.id,
          databaseExists: false,
          workerExists: false,
          machines: [],
          accountSubdomain: "someones-subdomain",
          rowsInCloud: null,
          ...over,
        },
      }),
    });
  }

  it("says ADOPT, with the row count, when a database already exists", async () => {
    const f = withDeployment({ databaseExists: true, workerExists: true, rowsInCloud: 4812 });
    await probeWith(f);
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("review"));

    const plan = f.container.querySelector('[data-slot="cloud-plan"]')?.textContent ?? "";
    expect(plan).toContain("Adopt");
    expect(plan).toContain("4812");
    expect(plan).toContain("Redeploy");
    expect(plan).toContain("Enrol this Mac");
    expect(plan).toContain("Nothing is minted for any other Mac");
  });

  it("lists the machines already enrolled", async () => {
    const f = withDeployment({
      databaseExists: true,
      workerExists: true,
      rowsInCloud: 12,
      machines: [machine(), machine({ machineId: THIS_MAC, label: "Mine", isThisMac: true })],
    });
    await probeWith(f);
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("review"));

    expect(f.container.querySelectorAll('[data-slot="machine-row"]')).toHaveLength(2);
    expect(f.container.textContent).toContain("Work MacBook");
  });

  it("offers no Revoke for the Mac it is running on", async () => {
    const f = withDeployment({
      databaseExists: true,
      workerExists: true,
      rowsInCloud: 12,
      machines: [machine(), machine({ machineId: THIS_MAC, label: "Mine", isThisMac: true })],
    });
    await probeWith(f);
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("review"));

    const mine = f.container.querySelector('[data-slot="machine-row"][data-this-mac="yes"]');
    expect(mine?.querySelector("button")).toBeNull();
    expect(mine?.textContent).toContain("re-running replaces this Mac’s token");
    // The other one does have it.
    const theirs = f.container.querySelector('[data-slot="machine-row"][data-this-mac="no"]');
    expect(theirs?.querySelector("button")).not.toBeNull();
  });

  it("confirms inline before revoking, and says what survives", async () => {
    const f = withDeployment({
      databaseExists: true,
      workerExists: true,
      rowsInCloud: 12,
      machines: [machine()],
    });
    await probeWith(f);
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("review"));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^revoke$/i }));
    });
    const confirm = f.container.querySelector('[data-slot="revoke-confirm"]');
    expect(confirm).not.toBeNull();
    expect(confirm?.textContent).toContain("stops Work MacBook from syncing immediately");
    expect(confirm?.textContent).toContain("Nothing it has already recorded is deleted");
    // Confirming has not happened yet, so nothing was sent.
    expect(f.revokes).toEqual([]);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /revoke work macbook/i }));
    });
    expect(f.revokes).toHaveLength(1);
    expect(f.revokes[0]?.machineId).toBe(OTHER_MAC);
  });

  it("asks for a workers.dev subdomain only when the account has none", async () => {
    const f = withDeployment({ accountSubdomain: null });
    await probeWith(f);
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("review"));

    const field = screen.getByLabelText(/workers.dev subdomain/i) as HTMLInputElement;
    // Account-wide and permanent in practice, so setup will not invent one.
    expect((screen.getByRole("button", { name: /set it up/i }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(field, { target: { value: "chosen-name" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /set it up/i }));
    });
    expect(f.runs[0]?.subdomain).toBe("chosen-name");
  });
});

describe("nothing anywhere asks which Mac this is", () => {
  const BANNED = ["personal Mac", "work Mac", "This is my"];

  it("never renders a slot question, in any phase", async () => {
    const f = mount();
    const seen = (): string => f.container.textContent ?? "";

    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("intro"));
    for (const b of BANNED) expect(seen(), `intro: ${b}`).not.toContain(b);

    await toTokenScreen(f);
    for (const b of BANNED) expect(seen(), `token: ${b}`).not.toContain(b);

    typeToken();
    await check();
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("review"));
    for (const b of BANNED) expect(seen(), `review: ${b}`).not.toContain(b);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /set it up/i }));
    });
    await waitFor(() => expect(panel(f.container).dataset["phase"]).toBe("done"));
    for (const b of BANNED) expect(seen(), `done: ${b}`).not.toContain(b);
  });
});

describe("this Mac's token, shown once, only if the keychain refused", () => {
  it("shows NO token on an ordinary successful run", async () => {
    // The happy path reveals nothing at all: this Mac's token went into this
    // Mac's keychain, and nothing is minted for anybody else.
    const f = mount();
    await runToDone(f);
    expect(f.container.querySelector('[data-slot="token-reveal"]')).toBeNull();
    expect(f.container.textContent).toContain("Sync is on");
  });

  it("explains how to add another Mac, and offers nothing to copy", async () => {
    const f = mount();
    await runToDone(f);
    const text = f.container.textContent ?? "";
    expect(text).toContain("run this same setup");
    expect(text).toContain("nothing to copy across");
    expect(f.container.querySelector('[data-slot="token-value"]')).toBeNull();
  });

  it("hands over THIS Mac's token when the keychain refused it", async () => {
    const f = mount({
      run: runResult({
        ok: false,
        unstoredToken: "this-macs-token-that-could-not-be-stored",
        error: "this system has no available safeStorage backend",
      }),
    });
    await runToDone(f);
    const reveal = f.container.querySelector('[data-slot="token-reveal"]');
    expect(reveal).not.toBeNull();
    expect(f.container.querySelector('[data-slot="token-value"]')?.textContent).toBe(
      "this-macs-token-that-could-not-be-stored",
    );
    expect(reveal?.textContent).toContain("only time it will ever be shown");
    expect(f.container.textContent).toContain("keychain would not store");
    // Rendered as element text, not as an input's value — nothing autofills a
    // <code>, and it is not an attribute anywhere.
    expect(f.container.querySelector<HTMLElement>('[data-slot="token-value"]')?.tagName).toBe(
      "CODE",
    );
  });
});

describe("progress", () => {
  it("renders every step, including enrol, with the failed one marked", async () => {
    const f = mount({
      run: runResult({
        ok: false,
        done: false,
        error: "the deploy was refused",
        steps: steps().map((s) =>
          s.id === "deploy" ? { ...s, state: "failed" as const, detail: "refused" } : s,
        ),
      }),
    });
    await runToDone(f);

    expect(f.container.querySelectorAll('[data-slot="cloud-steps"] li')).toHaveLength(9);
    expect(f.container.querySelector('[data-step="enrol"]')).not.toBeNull();
    expect(f.container.querySelector<HTMLElement>('[data-step="deploy"]')?.dataset["state"]).toBe(
      "failed",
    );
  });

  it("surfaces the reason a run stopped", async () => {
    const f = mount({
      run: runResult({ ok: false, done: false, error: "Cloudflare is rate-limiting" }),
    });
    await runToDone(f);
    expect(f.container.textContent).toContain("Cloudflare is rate-limiting");
  });
});
