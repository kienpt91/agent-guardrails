import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runExample } from "../examples/marketing-ops/run.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "example-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("marketing-ops example", () => {
  it("runs end to end with two approvals and each side effect applied once", async () => {
    const out = await runExample({ dir });
    expect(out.result.status).toBe("completed");
    expect(out.reviewerLog).toHaveLength(2);
    expect(out.emailsSent).toBe(1);
    expect(out.pages).toEqual(["page_0001=published"]);
  });

  it("is deterministic, so the README timeline can be checked", async () => {
    const a = await runExample({ dir });
    const other = mkdtempSync(join(tmpdir(), "example-"));
    try {
      expect((await runExample({ dir: other })).timeline).toBe(a.timeline);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("dry-run changes nothing and yields a three-step plan", async () => {
    const out = await runExample({ dir, dryRun: true });
    expect(out.result.status).toBe("completed");
    expect(out.reviewerLog).toEqual([]);
    expect(out.emailsSent).toBe(0);
    expect(out.pages).toEqual([]);
    expect(out.result.plan.map((p) => p.tool)).toEqual(["cms_create_draft", "cms_publish_page", "crm_send_email"]);
    expect(out.plan).toContain("3 intended side effects (nothing was executed)");
  });

  it("README shows the timeline this code produces", async () => {
    const out = await runExample({ dir });
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const block = /<!-- timeline:start -->\n```text\n([\s\S]*?)\n```\n<!-- timeline:end -->/.exec(readme);
    expect(block, "README timeline block").not.toBeNull();
    expect(block![1]).toBe(out.timeline);
  });

  it("README shows the dry-run plan this code produces", async () => {
    const out = await runExample({ dir, dryRun: true });
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const block = /<!-- plan:start -->\n```text\n([\s\S]*?)\n```\n<!-- plan:end -->/.exec(readme);
    expect(block, "README plan block").not.toBeNull();
    expect(block![1]).toBe(out.plan);
  });
});
