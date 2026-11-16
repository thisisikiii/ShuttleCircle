// Self-check for the Jakarta/UTC and money helpers: `npm run check`.
import assert from "node:assert/strict";
import { fromJakartaInput, jakartaDay, monthStart, rupiah, toJakartaInput } from "./format.ts";

assert.equal(fromJakartaInput("2026-12-01T19:00"), "2026-12-01T12:00:00.000Z");
assert.equal(fromJakartaInput("2026-12-01T03:00"), "2026-11-30T20:00:00.000Z");
assert.equal(toJakartaInput("2026-12-01T12:00:00Z"), "2026-12-01T19:00");
assert.equal(jakartaDay("2026-11-30T18:30:00Z"), "2026-12-01");
assert.equal(rupiah(50000).replace(/\s/g, " "), "Rp 50.000");
assert.match(monthStart(1), /^\d{4}-\d{2}-01$/);
console.log("format ok");
