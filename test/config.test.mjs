import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  DELEGATE_CONFIG_FILENAME,
  getDelegateConfigPath,
  getProjectDelegateConfigPath,
  loadDelegateProfiles,
  MAX_CONFIG_BYTES,
  MAX_MODEL_BYTES,
  MAX_PROFILE_DEADLINE_MS,
  MAX_PROMPT_BYTES,
} from "../src/config.ts";
import { BUNDLED_PROFILES, DELEGATE_THINKING_LEVELS } from "../src/agents.ts";

async function temporaryConfig() {
  const directory = await mkdtemp(join(tmpdir(), "pi-delegator-config-"));
  const prompt = join(directory, "custom.md");
  const skill = join(directory, "skill.md");
  const skillDirectory = join(directory, "skill-directory");
  const extension = join(directory, "extension.ts");
  await writeFile(prompt, "Custom role prompt\n");
  await writeFile(skill, "---\nname: fixture-skill\ndescription: Fixture skill\n---\n");
  await mkdir(skillDirectory);
  await writeFile(join(skillDirectory, "SKILL.md"), "---\nname: directory-skill\ndescription: Directory skill\n---\n");
  await writeFile(extension, "export default function () {}\n");
  return {
    directory,
    path: join(directory, DELEGATE_CONFIG_FILENAME),
    prompt,
    skill,
    skillDirectory,
    extension,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function completeProfile(overrides = {}) {
  return {
    description: "Custom profile",
    model: " example/custom ",
    thinking: "medium",
    prompt: "custom.md",
    tools: ["read", "custom_tool"],
    skills: [],
    extensions: [],
    deadlineMs: 12_345,
    ...overrides,
  };
}

function assertConfigError(fn, path, profile, expected) {
  assert.throws(fn, (error) => {
    assert.match(error.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (profile !== undefined) assert.match(error.message, new RegExp(`profile ["']?${profile}`));
    assert.match(error.message, expected);
    assert.match(error.message, /Corrective action:/);
    return true;
  });
}

test("missing config preserves the five immutable bundled profiles and Pi agent directory", async () => {
  const fixture = await temporaryConfig();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = fixture.directory;
  try {
    assert.equal(getDelegateConfigPath(), fixture.path);
    const profiles = loadDelegateProfiles();
    assert.equal(profiles, BUNDLED_PROFILES);
    assert.deepEqual(Object.keys(profiles), ["scout", "reviewer", "oracle", "tester", "worker"]);
    assert.equal(Object.isFrozen(profiles), true);
    assert.equal(Object.isFrozen(profiles.scout), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await fixture.cleanup();
  }
});

test("adds, completely replaces, disables, normalizes, and freezes user profiles", async () => {
  const fixture = await temporaryConfig();
  try {
    await writeFile(
      fixture.path,
      JSON.stringify({
        profiles: {
          scout: null,
          reviewer: completeProfile({ description: "Replacement reviewer", model: null, tools: ["read"], deadlineMs: 999 }),
          custom: completeProfile(),
        },
      }),
    );
    const profiles = loadDelegateProfiles(fixture.path);
    assert.equal(Object.hasOwn(profiles, "scout"), false);
    assert.equal(profiles.reviewer.description, "Replacement reviewer");
    assert.equal(profiles.reviewer.model, null);
    assert.equal(profiles.reviewer.timeoutMs, 999);
    assert.equal(profiles.reviewer.systemPrompt, "Custom role prompt\n");
    assert.deepEqual(profiles.custom.tools, ["read", "custom_tool"]);
    assert.equal(profiles.custom.model, "example/custom");
    assert.equal(profiles.custom.thinking, "medium");
    assert.equal(Object.isFrozen(profiles), true);
    assert.equal(Object.isFrozen(profiles.custom), true);
    assert.equal(Object.isFrozen(profiles.custom.tools), true);

    for (const thinking of DELEGATE_THINKING_LEVELS) {
      await writeFile(fixture.path, JSON.stringify({ profiles: { custom: completeProfile({ thinking }) } }));
      assert.equal(loadDelegateProfiles(fixture.path).custom.thinking, thinking);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("resolves project profiles over user and bundled profiles without merging entries", async () => {
  const user = await temporaryConfig();
  const project = await temporaryConfig();
  try {
    await writeFile(
      user.path,
      JSON.stringify({
        profiles: {
          reviewer: completeProfile({ description: "User reviewer", tools: ["read"] }),
          user_only: completeProfile({ description: "User only" }),
        },
      }),
    );
    await writeFile(
      project.path,
      JSON.stringify({
        profiles: {
          scout: null,
          reviewer: completeProfile({ description: "Project reviewer", model: null, thinking: "high", tools: ["bash"] }),
          project_only: completeProfile({ description: "Project only" }),
        },
      }),
    );

    const userProfiles = loadDelegateProfiles(user.path);
    const profiles = loadDelegateProfiles(project.path, userProfiles);
    assert.equal(Object.hasOwn(profiles, "scout"), false);
    assert.equal(profiles.reviewer.description, "Project reviewer");
    assert.equal(profiles.reviewer.model, null);
    assert.equal(profiles.reviewer.thinking, "high");
    assert.deepEqual(profiles.reviewer.tools, ["bash"]);
    assert.equal(profiles.reviewer.systemPrompt, "Custom role prompt\n");
    assert.equal(profiles.user_only.description, "User only");
    assert.equal(profiles.project_only.description, "Project only");
    assert.equal(Object.isFrozen(profiles), true);
    assert.equal(getProjectDelegateConfigPath("/tmp/example"), join("/tmp/example", ".pi", DELEGATE_CONFIG_FILENAME));
  } finally {
    await user.cleanup();
    await project.cleanup();
  }
});

test("resolves, validates, and freezes explicit local capability paths", async () => {
  const fixture = await temporaryConfig();
  try {
    await writeFile(
      fixture.path,
      JSON.stringify({
        profiles: {
          custom: completeProfile({
            skills: ["skill.md", "skill-directory"],
            extensions: ["extension.ts"],
          }),
        },
      }),
    );

    const profile = loadDelegateProfiles(fixture.path).custom;
    assert.deepEqual(profile.skills, [await realpath(fixture.skill), await realpath(fixture.skillDirectory)]);
    assert.deepEqual(profile.extensions, [await realpath(fixture.extension)]);
    assert.equal(Object.isFrozen(profile.skills), true);
    assert.equal(Object.isFrozen(profile.extensions), true);
  } finally {
    await fixture.cleanup();
  }
});

test("rejects duplicate capability aliases and explicit pi-delegator loading", async () => {
  const fixture = await temporaryConfig();
  try {
    const skillAlias = join(fixture.directory, "skill-alias.md");
    const delegatorHardLink = join(fixture.directory, "delegator-alias.ts");
    await symlink(fixture.skill, skillAlias);
    await link(resolve("src/index.ts"), delegatorHardLink);
    for (const [overrides, expected] of [
      [{ skills: ["skill.md", "./skill.md"] }, /skills contains duplicate path/],
      [{ skills: ["skill.md", "skill-alias.md"] }, /skills contains duplicate path/],
      [{ extensions: [resolve("src/index.ts")] }, /may not explicitly load pi-delegator/],
      [{ extensions: ["delegator-alias.ts"] }, /may not explicitly load pi-delegator/],
    ]) {
      await writeFile(fixture.path, JSON.stringify({ profiles: { custom: completeProfile(overrides) } }));
      assertConfigError(() => loadDelegateProfiles(fixture.path), fixture.path, "custom", expected);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("rejects legacy, malformed, incomplete, and unknown configuration with corrective diagnostics", async () => {
  const fixture = await temporaryConfig();
  try {
    for (const [contents, profile, expected] of [
      ["", undefined, /valid UTF-8 JSON/],
      ["null", undefined, /top level must be an object/],
      ["[]", undefined, /top level must be an object/],
      [JSON.stringify({ scout: { model: "old/model" } }), undefined, /legacy or incomplete format/],
      [JSON.stringify({ profiles: [] }), undefined, /"profiles" must be an object/],
      [JSON.stringify({ profiles: {}, extra: true }), undefined, /unknown top-level field/],
      [JSON.stringify({ profiles: { custom: {} } }), "custom", /incomplete; missing/],
      [JSON.stringify({ profiles: { custom: { ...completeProfile(), extra: true } } }), "custom", /unknown field/],
      [JSON.stringify({ profiles: { "Bad Name": null } }), "Bad Name", /name must match/],
    ]) {
      await writeFile(fixture.path, contents);
      assertConfigError(() => loadDelegateProfiles(fixture.path), fixture.path, profile, expected);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("rejects unsafe or invalid complete profile fields before delegation", async () => {
  const fixture = await temporaryConfig();
  try {
    const cases = [
      [completeProfile({ description: " " }), /description must be a non-blank string/],
      [completeProfile({ model: 42 }), /model must be a string/],
      [completeProfile({ model: "é".repeat(MAX_MODEL_BYTES) }), /model exceeds.*UTF-8 limit/],
      [completeProfile({ thinking: "extreme" }), /thinking must be one of/],
      [completeProfile({ tools: [] }), /tools must be a non-empty array/],
      [completeProfile({ tools: ["read", "read"] }), /duplicate/],
      [completeProfile({ tools: ["delegate"] }), /nested delegation is forbidden/],
      [completeProfile({ tools: ["bad/tool"] }), /invalid name/],
      [completeProfile({ skills: "skill.md" }), /skills must be an array/],
      [completeProfile({ skills: [""] }), /skills contains invalid path/],
      [completeProfile({ skills: ["missing.md"] }), /skills path .* could not be read/],
      [completeProfile({ skills: ["extension.ts"] }), /skills path .* is unsupported/],
      [completeProfile({ extensions: ["missing.ts"] }), /extensions path .* could not be read/],
      [completeProfile({ extensions: ["custom.md"] }), /extensions path .* is unsupported/],
      [completeProfile({ extensions: ["."] }), /extensions path .* is unsupported/],
      [completeProfile({ extensions: ["npm:example-extension"] }), /not a supported local filesystem path/],
      [completeProfile({ deadlineMs: 0 }), /deadlineMs must be a positive integer/],
      [completeProfile({ deadlineMs: MAX_PROFILE_DEADLINE_MS + 1 }), /deadlineMs must be a positive integer/],
      [completeProfile({ prompt: "missing.md" }), /could not be read/],
      [completeProfile({ prompt: "custom.txt" }), /Markdown file/],
    ];
    for (const [profile, expected] of cases) {
      await writeFile(fixture.path, JSON.stringify({ profiles: { custom: profile } }));
      assertConfigError(() => loadDelegateProfiles(fixture.path), fixture.path, "custom", expected);
    }

    await writeFile(fixture.prompt, " ");
    await writeFile(fixture.path, JSON.stringify({ profiles: { custom: completeProfile() } }));
    assertConfigError(() => loadDelegateProfiles(fixture.path), fixture.path, "custom", /prompt .* is empty/);

    await writeFile(fixture.prompt, "x".repeat(MAX_PROMPT_BYTES + 1));
    assertConfigError(() => loadDelegateProfiles(fixture.path), fixture.path, "custom", /prompt .* exceeds/);
  } finally {
    await fixture.cleanup();
  }
});

test("bounds the whole config and reports non-missing read failures", async () => {
  const fixture = await temporaryConfig();
  try {
    const document = JSON.stringify({ profiles: {} });
    await writeFile(fixture.path, document + " ".repeat(MAX_CONFIG_BYTES - document.length));
    assert.deepEqual(Object.keys(loadDelegateProfiles(fixture.path)), Object.keys(BUNDLED_PROFILES));

    await writeFile(fixture.path, " ".repeat(MAX_CONFIG_BYTES + 1));
    assertConfigError(() => loadDelegateProfiles(fixture.path), fixture.path, undefined, /file exceeds.*byte limit/);

    const directoryPath = join(fixture.directory, "not-a-file");
    await mkdir(directoryPath);
    assertConfigError(() => loadDelegateProfiles(directoryPath), directoryPath, undefined, /file could not be read/);
  } finally {
    await fixture.cleanup();
  }
});
