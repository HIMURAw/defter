import { test } from "node:test";
import assert from "node:assert/strict";
import {
  changePassword,
  createLock,
  isLockedText,
  normalizeRecovery,
  parseLocked,
  renewRecovery,
  sealNotebook,
  unlockWithPassword,
  unlockWithRecovery,
  WrongSecretError,
} from "../src/lock.ts";

const ITER = 1000; // fast in tests; the plugin uses 310 000
const plain = "---\ndefter-plugin: notebook\n---\n\n<!-- defter:page date=2026-11-10 -->\nBugün çok güzel bir gündü. Şifre: gizli\n";

test("lock, unlock with password, nothing readable in the file", async () => {
  const { session, recovery } = await createLock("elma123", "meyve", ITER);
  const file = await sealNotebook(session, "defter-plugin: notebook\ndefter-journal: true", plain);
  assert.ok(isLockedText(file));
  assert.ok(!file.includes("güzel") && !file.includes("gizli") && !file.includes("2026-11-10"));
  assert.match(file, /^---\ndefter-plugin: notebook\ndefter-journal: true\ndefter-lock: v1\n---/);
  const { data } = parseLocked(file);
  assert.equal(data.hint, "meyve");
  const opened = await unlockWithPassword(data, "elma123");
  assert.equal(opened.text, plain);
  await assert.rejects(unlockWithPassword(data, "armut"), WrongSecretError);
  assert.match(recovery, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/);
});

test("forgot password: recovery key opens it and sets a new password", async () => {
  const { session, recovery } = await createLock("eski", undefined, ITER);
  let file = await sealNotebook(session, "defter-plugin: notebook", plain);
  const typed = recovery.toLowerCase().replace(/-/g, " ");
  const r = await unlockWithRecovery(parseLocked(file).data, typed);
  assert.equal(r.text, plain);
  await changePassword(r.session, "yeni");
  file = await sealNotebook(r.session, "defter-plugin: notebook\ndefter-lock: v1", r.text + "ek satır\n");
  const data = parseLocked(file).data;
  await assert.rejects(unlockWithPassword(data, "eski"), WrongSecretError);
  assert.equal((await unlockWithPassword(data, "yeni")).text, plain + "ek satır\n");
  // The recovery key keeps working after a password change.
  assert.equal((await unlockWithRecovery(data, recovery)).text, plain + "ek satır\n");
  assert.equal(normalizeRecovery(" ab-cd "), "ABCD");
});

test("a new recovery key replaces the old one", async () => {
  const { session, recovery } = await createLock("pw", undefined, ITER);
  const fresh = await renewRecovery(session);
  const file = await sealNotebook(session, "defter-plugin: notebook", plain);
  const data = parseLocked(file).data;
  await assert.rejects(unlockWithRecovery(data, recovery), WrongSecretError);
  assert.equal((await unlockWithRecovery(data, fresh)).text, plain);
});

test("damaged blocks are reported, never guessed", async () => {
  assert.throws(() => parseLocked("---\na: b\n---\n\n<!-- defter:locked\n{not json\n-->\n"), /damaged/);
  const { session } = await createLock("pw", undefined, ITER);
  const file = await sealNotebook(session, "defter-plugin: notebook", plain);
  const data = parseLocked(file).data;
  data.ct = "AAAA" + data.ct.slice(4);
  await assert.rejects(unlockWithPassword(data, "pw"), /damaged/);
});

test("absurd iteration counts are refused, CRLF files are read", async () => {
  const { session } = await createLock("pw", undefined, ITER);
  const file = await sealNotebook(session, "defter-plugin: notebook", plain);
  assert.throws(() => parseLocked(file.replace(/"iter":1000/, '"iter":999999999')), /damaged/);
  const crlf = file.replace(/\n/g, "\r\n");
  assert.equal((await unlockWithPassword(parseLocked(crlf).data, "pw")).text, plain);
});
