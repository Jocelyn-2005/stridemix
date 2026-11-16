import test from "node:test";
import assert from "node:assert/strict";
import { parseRoute, routeHash } from "../src/routing.ts";

test("the initial view follows whether a saved arrangement exists", () => {
  assert.deepEqual(parseRoute("", false), { page: "library" });
  assert.deepEqual(parseRoute("", true), { page: "mix" });
});

test("each workspace page supports a direct hash URL", () => {
  for (const page of ["library", "import", "mix", "rhythm", "export", "appearance"]) {
    assert.deepEqual(parseRoute(`#/${page}`, false), { page });
  }
});

test("track routes preserve the stable entry identifier through encoding", () => {
  const route = { page: "track", entryId: "entry / 中文%" };
  assert.deepEqual(parseRoute(routeHash(route), false), route);
});

test("unknown and malformed routes safely return to an available starting page", () => {
  for (const hash of ["#/unknown", "#/track", "#/track/", "#/track/%ZZ", "#/mix/extra", "#/constructor", "#/toString"]) {
    assert.deepEqual(parseRoute(hash, true), { page: "mix" });
  }
});
