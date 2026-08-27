import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  DELEGATE_CONFIG_FILENAME,
  getDelegateConfigPath,
  loadDelegateDefaults,
  MAX_CONFIG_BYTES,
  MAX_MODEL_BYTES,
} from "../src/config.ts";
import { DELEGATE_THINKING_LEVELS } from "../src/agents.ts";

async function temporaryConfig() {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-config-"));
  return {
    directory,
    path: join(directory, DELEGATE_CONFIG_FILENAME),
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("missing config preserves empty immutable defaults and the Pi agent directory", async () => {
  const fixture = await temporaryConfig();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fixture.directory;
  try {
    assert.equal(getDelegateConfigPath(), fixture.path);
    const defaults = loadDelegateDefaults();
    assert.deepEqual(defaults, {});
    assert.equal(Object.isFrozen(defaults), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fixture.cleanup();
  }
});

test("loads, normalizes, and freezes per-profile model and thinking defaults", async () => {
  const fixture = await temporaryConfig();
  try {
    await writeFile(
      fixture.path,
      JSON.stringify({
        scout: { model: " example/scout ", thinking: "medium" },
        reviewer: { thinking: "high" },
      }),
    );
    const defaults = loadDelegateDefaults(fixture.path);
    assert.equal(defaults.scout?.model, "example/scout");
    assert.equal(defaults.scout?.thinking, "medium");
    assert.equal(defaults.reviewer?.thinking, "high");
    assert.equal(Object.isFrozen(defaults), true);
    assert.equal(Object.isFrozen(defaults.scout), true);

    for (const thinking of DELEGATE_THINKING_LEVELS) {
      await writeFile(fixture.path, JSON.stringify({ scout: { thinking } }));
      assert.equal(loadDelegateDefaults(fixture.path).scout?.thinking, thinking);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("rejects malformed JSON and non-object config shapes precisely", async () => {
  const fixture = await temporaryConfig();
  try {
    for (const [contents, expected] of [
      ["", /expected valid UTF-8 JSON/],
      ["{", /expected valid UTF-8 JSON/],
      ["null", /top level must be an object/],
      ["[]", /top level must be an object/],
      [JSON.stringify({ scout: null }), /profile "scout" must be an object/],
    ]) {
      await writeFile(fixture.path, contents);
      assert.throws(() => loadDelegateDefaults(fixture.path), (error) => {
        assert.match(error.message, new RegExp(fixture.path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        assert.match(error.message, expected);
        return true;
      });
    }
  } finally {
    await fixture.cleanup();
  }
});

test("rejects unknown profiles and every field outside model and thinking", async () => {
  const fixture = await temporaryConfig();
  try {
    for (const profile of ["toString", "planner"]) {
      await writeFile(fixture.path, JSON.stringify({ [profile]: {} }));
      assert.throws(() => loadDelegateDefaults(fixture.path), new RegExp(`unknown profile.*${profile}`));
    }
    for (const field of ["tools", "systemPrompt", "timeoutMs"]) {
      await writeFile(fixture.path, JSON.stringify({ scout: { [field]: "forbidden" } }));
      assert.throws(() => loadDelegateDefaults(fixture.path), new RegExp(`unknown field.*${field}.*scout`));
    }
  } finally {
    await fixture.cleanup();
  }
});

test("rejects invalid or oversized model and thinking defaults", async () => {
  const fixture = await temporaryConfig();
  try {
    for (const [value, expected] of [
      [42, /model must be a string/],
      ["   ", /model must not be blank/],
      ["é".repeat(MAX_MODEL_BYTES), /model exceeds.*UTF-8 limit/],
    ]) {
      await writeFile(fixture.path, JSON.stringify({ scout: { model: value } }));
      assert.throws(() => loadDelegateDefaults(fixture.path), expected);
    }
    for (const value of [42, "extreme"]) {
      await writeFile(fixture.path, JSON.stringify({ scout: { thinking: value } }));
      assert.throws(() => loadDelegateDefaults(fixture.path), /thinking must be one of/);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("bounds the whole config and reports non-missing read failures", async () => {
  const fixture = await temporaryConfig();
  try {
    const prefix = "{\"scout\":{}}";
    await writeFile(fixture.path, prefix + " ".repeat(MAX_CONFIG_BYTES - prefix.length));
    assert.deepEqual(loadDelegateDefaults(fixture.path), { scout: {} });

    await writeFile(fixture.path, " ".repeat(MAX_CONFIG_BYTES + 1));
    assert.throws(() => loadDelegateDefaults(fixture.path), /file exceeds.*byte limit/);

    const directoryPath = join(fixture.directory, "not-a-file");
    await mkdir(directoryPath);
    assert.throws(() => loadDelegateDefaults(directoryPath), /file could not be read/);
  } finally {
    await fixture.cleanup();
  }
});
