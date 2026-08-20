import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PACKAGED_FAKE_ENV,
  createSignalSource,
  shouldUseFake,
  FakeSignalSource,
} from "@/native";

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * The fake/real decision. Getting it wrong in either direction is silent:
 * a real source in a test hangs or crashes on a machine with no grant, and a
 * fake source in a packaged build measures nothing at all while looking
 * perfectly healthy.
 */
describe("createSignalSource", () => {
  it("gives an unpackaged build the fake when WWB_FAKE_NATIVE=1", () => {
    expect(shouldUseFake({ isPackaged: false }, { WWB_FAKE_NATIVE: "1" })).toBe(true);
  });

  it("gives an unpackaged build the fake under NODE_ENV=test", () => {
    expect(shouldUseFake({ isPackaged: false }, { NODE_ENV: "test" })).toBe(true);
  });

  it("never gives a packaged build the fake, whatever the environment says", () => {
    // An env var leaking into the app bundle must not be able to turn the
    // shipped tracker into a no-op.
    expect(shouldUseFake({ isPackaged: true }, { WWB_FAKE_NATIVE: "1" })).toBe(false);
    expect(shouldUseFake({ isPackaged: true }, { NODE_ENV: "test" })).toBe(false);
  });

  it("still refuses a packaged build that is not a smoke run", () => {
    // Both variables present is not enough. The process also has to have been
    // started with --smoke, which mints a throwaway profile before whenReady().
    expect(
      shouldUseFake(
        { isPackaged: true },
        { WWB_FAKE_NATIVE: "1", [PACKAGED_FAKE_ENV]: "1" },
      ),
    ).toBe(false);
  });

  it("still refuses a packaged smoke run without the second variable", () => {
    expect(
      shouldUseFake({ isPackaged: true, isSmokeRun: true }, { WWB_FAKE_NATIVE: "1" }),
    ).toBe(false);
  });

  it("lets a PACKAGED SMOKE RUN take the fake when all three signals line up", () => {
    // The one door, and the reason it exists: a packaged build no test could
    // start is how an app with no windows reached the owner. src/main/smoke.ts.
    expect(
      shouldUseFake(
        { isPackaged: true, isSmokeRun: true },
        { WWB_FAKE_NATIVE: "1", [PACKAGED_FAKE_ENV]: "1" },
      ),
    ).toBe(true);
  });

  it("gives an ordinary unpackaged run the real source", () => {
    expect(shouldUseFake({ isPackaged: false }, {})).toBe(false);
  });

  it("returns a FakeSignalSource when asked, without loading koffi", async () => {
    // Stubbed rather than relying on the runner's NODE_ENV: if this ever
    // resolved the real source, the import would throw on any non-Mac and the
    // whole point of the seam would be gone.
    vi.stubEnv("WWB_FAKE_NATIVE", "1");
    const source = await createSignalSource({ isPackaged: false });
    expect(source).toBeInstanceOf(FakeSignalSource);
  });
});
