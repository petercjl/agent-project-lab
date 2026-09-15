import { test } from "node:test";
import assert from "node:assert/strict";
import { buildAuthorizeUrl, safeReturnTo } from "../auth.ts";

test("DingTalk authorization URL uses code flow and enterprise scope", () => {
  const url = new URL(
    buildAuthorizeUrl(
      "client-id",
      "http://127.0.0.1:4317/api/auth/dingtalk/callback",
      "state-value",
    ),
  );
  assert.equal(url.origin, "https://login.dingtalk.com");
  assert.equal(url.pathname, "/oauth2/auth");
  assert.equal(url.searchParams.get("client_id"), "client-id");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "openid corpid");
  assert.equal(url.searchParams.get("state"), "state-value");
});

test("OAuth return path cannot escape the local application", () => {
  assert.equal(safeReturnTo("/projects/demo"), "/projects/demo");
  assert.equal(safeReturnTo("https://attacker.example"), "/");
  assert.equal(safeReturnTo("//attacker.example"), "/");
  assert.equal(safeReturnTo(undefined), "/");
});
