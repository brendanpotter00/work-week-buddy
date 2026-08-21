/**
 * The code-identity read. `codesign` itself is stubbed — this file is about
 * what the doctor does with its answers, not about Apple's tool.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { bundlePathOf, designatedRequirementFrom, readCodesign, UNPROBED } from "./codesign";

const REQUIREMENT =
  'identifier "com.bpotter.workweekbuddy" and certificate leaf = H"0123456789abcdef"';

describe("bundlePathOf", () => {
  it("walks up from the executable to the bundle", () => {
    expect(bundlePathOf("/Applications/Work Week Buddy.app/Contents/MacOS/Work Week Buddy")).toBe(
      "/Applications/Work Week Buddy.app",
    );
  });

  it("reports on the bundle it is actually inside, not on /Applications", () => {
    // A doctor run against a dev build or a copy on an external volume must
    // describe THAT bundle. Hardcoding /Applications would have it verify a
    // signature belonging to a different app than the one running.
    expect(bundlePathOf("/Volumes/T/W.app/Contents/MacOS/W")).toBe("/Volumes/T/W.app");
    expect(bundlePathOf("/usr/local/bin/electron")).toBe("/usr/local/bin/electron");
  });
});

describe("reading the designated requirement out of codesign", () => {
  // Both strings below were copied from this machine, not invented.
  it("takes the signed-with-an-identity form", () => {
    expect(
      designatedRequirementFrom(
        'designated => identifier "com.bpotter.workweekbuddy" and certificate leaf = H"6b6949d1"\n',
      ),
    ).toBe('identifier "com.bpotter.workweekbuddy" and certificate leaf = H"6b6949d1"');
  });

  it("takes the AD-HOC form, which codesign comments out", () => {
    // A cdhash requirement is not expressible in requirement language, so
    // codesign emits it behind a `#`. That is what `npm install electron`
    // ships and what every local rebuild without a certificate produces — the
    // population whose identity churns most, and the one the first version of
    // this parser silently reported `null` for.
    expect(designatedRequirementFrom('# designated => cdhash H"7f6315c1"\n')).toBe(
      'cdhash H"7f6315c1"',
    );
  });

  it("is null when codesign said nothing about a designated requirement", () => {
    expect(designatedRequirementFrom("Executable=/tmp/x\nIdentifier=y\n")).toBeNull();
    expect(designatedRequirementFrom("")).toBeNull();
  });
});

describe("readCodesign", () => {
  it("hashes the designated requirement rather than carrying it", async () => {
    // The requirement contains `certificate leaf = H"…"` and reports get pasted
    // into issues on a public repository. A hash answers the only question ever
    // asked of it — "is this the same identity as last time?" — and leaks
    // nothing.
    const state = await readCodesign({
      bundlePath: "/Applications/Work Week Buddy.app",
      designatedRequirement: () => Promise.resolve(REQUIREMENT),
      verify: () => Promise.resolve(true),
    });
    expect(state.designatedRequirementSha256).toBe(
      createHash("sha256").update(REQUIREMENT).digest("hex"),
    );
    expect(state.designatedRequirementSha256).not.toContain("certificate");
    expect(state.valid).toBe(true);
    expect(state.probed).toBe(true);
  });

  it("is the same hash for the same identity and a different one when it changes", async () => {
    // This is the whole value of the field: a grant that "was working
    // yesterday" is explained by this number having changed, and by nothing
    // else in the report. AGENTS.md silent-failure #2.
    const read = (r: string): Promise<string | null> => Promise.resolve(r);
    const a = await readCodesign({ designatedRequirement: () => read(REQUIREMENT), verify: () => Promise.resolve(true) });
    const b = await readCodesign({ designatedRequirement: () => read(REQUIREMENT), verify: () => Promise.resolve(true) });
    const c = await readCodesign({
      designatedRequirement: () => read('identifier "com.bpotter.workweekbuddy" and certificate leaf = H"ffff"'),
      verify: () => Promise.resolve(true),
    });
    expect(a.designatedRequirementSha256).toBe(b.designatedRequirementSha256);
    expect(c.designatedRequirementSha256).not.toBe(a.designatedRequirementSha256);
  });

  it("says NOT KNOWN, not NOT SIGNED, when codesign could not answer", async () => {
    const state = await readCodesign({
      designatedRequirement: () => Promise.resolve(null),
      verify: () => Promise.resolve(null),
    });
    expect(state.designatedRequirementSha256).toBeNull();
    expect(state.valid).toBeNull();
    // It still looked. That is the difference between this and `UNPROBED`.
    expect(state.probed).toBe(true);
    expect(UNPROBED.probed).toBe(false);
  });

  it("reports a broken seal as false", async () => {
    const state = await readCodesign({
      designatedRequirement: () => Promise.resolve(REQUIREMENT),
      verify: () => Promise.resolve(false),
    });
    expect(state.valid).toBe(false);
  });

  it("never throws, whatever codesign does", async () => {
    const state = await readCodesign({
      designatedRequirement: () => Promise.reject(new Error("ENOENT")),
      verify: () => Promise.reject(new Error("timed out")),
    });
    expect(state.probed).toBe(true);
    expect(state.designatedRequirementSha256).toBeNull();
    expect(state.valid).toBeNull();
  });
});
