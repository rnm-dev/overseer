import assert from "node:assert/strict";
import test from "node:test";
import { showsUserBox } from "./AppLayout";

test("the user card is shown only on the home page", () => {
  assert.equal(showsUserBox("/"), true);
  assert.equal(showsUserBox("/workspaces/workspace/members"), false);
  assert.equal(showsUserBox("/workspaces/workspace/sessions"), false);
  assert.equal(showsUserBox("/peons/peon/sessions"), false);
});
