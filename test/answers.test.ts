import assert from "node:assert/strict";
import test from "node:test";
import { buildUserInputAnswers } from "../src/answers.ts";
import { credentialMethod } from "../src/raw.ts";

const questions = [
  {
    id: "filename",
    selection: { mode: "single" },
    options: [{ label: "alpha.txt" }, { label: "beta.txt" }],
  },
];

test("a matching option becomes selectedLabel and other text is freeText", () => {
  assert.deepEqual(buildUserInputAnswers(questions, "beta.txt"), [{ questionId: "filename", selectedLabel: "beta.txt" }]);
  const free = buildUserInputAnswers(questions, "x".repeat(600));
  assert.equal(free[0]?.freeText?.length, 500);
});

test("credential methods are refused by name", () => {
  assert.equal(credentialMethod("account/loginStart"), true);
  assert.equal(credentialMethod("mcpServer/oauthLogin"), true);
  assert.equal(credentialMethod("session/compact"), false);
});
