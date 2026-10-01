import assert from "node:assert/strict";
import test from "node:test";
import { profileLabel } from "../src/agents.ts";

test("profile labels prefer custom names and title-case hyphen-separated identifiers", () => {
  assert.equal(profileLabel("worker"), "Worker");
  assert.equal(profileLabel("interaction-designer"), "Interaction Designer");
  assert.equal(profileLabel("interaction-designer", "UX Specialist"), "UX Specialist");
  assert.equal(profileLabel("worker", "审阅员"), "审阅员");
});
