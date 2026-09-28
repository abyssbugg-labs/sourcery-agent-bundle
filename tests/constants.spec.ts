import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  BULK_UPDATE_MAX_IDS,
  ISSUE_TYPES,
  LIST_MAX_LIMIT,
  SEVERITIES,
  SPEC_INFO,
  SPEC_SHA256,
  SPEC_SNAPSHOT_PATH,
  STATUSES,
  STATUS_INPUTS,
  VERIFIED_OPERATIONS,
} from "../src/constants.js";

const snapshotPath = new URL(`../${SPEC_SNAPSHOT_PATH}`, import.meta.url);

interface Snapshot {
  info: { title: string; version: string };
  openapi: string;
  paths: Record<string, Record<string, unknown>>;
}

function loadSnapshot(): Snapshot {
  return JSON.parse(readFileSync(snapshotPath, "utf8")) as Snapshot;
}

function normalize(path: string): string {
  return path.replace(/\{[^}]+\}/g, "{}");
}

describe("pinned OpenAPI snapshot", () => {
  it("matches the pinned SHA-256", () => {
    const digest = createHash("sha256")
      .update(readFileSync(snapshotPath))
      .digest("hex");
    expect(digest).toBe(SPEC_SHA256);
  });

  it("keeps SPEC_INFO in sync with the snapshot info block", () => {
    const spec = loadSnapshot();
    expect(`${spec.info.title} ${spec.info.version} (OpenAPI ${spec.openapi})`).toBe(SPEC_INFO);
  });

  it("contains every verified operation with the pinned method", () => {
    const spec = loadSnapshot();
    const specPathsByNormalized = new Map(
      Object.keys(spec.paths).map((path) => [normalize(path), path]),
    );
    for (const operation of VERIFIED_OPERATIONS) {
      const normalized = normalize(operation.path.replace(/^\/api/, ""));
      const concrete = specPathsByNormalized.get(normalized);
      expect(concrete, operation.path).toBeDefined();
      expect(spec.paths[concrete!] ?? {}, `${operation.method} ${operation.path}`).toHaveProperty(
        operation.method.toLowerCase(),
      );
    }
  });
});

describe("pinned enums and bounds", () => {
  it("keeps SOLVED out of PATCH inputs but present on records", () => {
    expect(STATUS_INPUTS).not.toContain("SOLVED");
    expect(STATUSES).toContain("SOLVED");
  });

  it("caps bulk updates at 100 ids and list pages at 100", () => {
    expect(BULK_UPDATE_MAX_IDS).toBe(100);
    expect(LIST_MAX_LIMIT).toBe(100);
  });

  it("exposes the documented enums", () => {
    expect(ISSUE_TYPES).toEqual(["SAST", "IAC", "SECRET", "DEPENDENCY", "LICENSE"]);
    expect(SEVERITIES).toEqual(["NO_RISK", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
    expect(STATUS_INPUTS).toEqual(["ACTIVE", "IGNORED", "SNOOZED"]);
  });
});
