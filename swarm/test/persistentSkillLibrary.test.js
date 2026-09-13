import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
import { emptySkillLibrary, admitCheckedSkill, validateSkillLibrary, saveSkillLibrary, loadSkillLibrary } from "../src/persistentSkillLibrary.js";

const modelIdentity = { model: "fixed-parent", weightsSha256: "a".repeat(64) };
const program = { schema: "amos.checked-procedure.v1", steps: [
  { type: "call", tool: "write", args: { title: { $ref: "goal.title" } }, saveAs: "written" },
  { type: "return", status: "completed" }
] };
const learningEvidence = { demonstrationsSha256: "b".repeat(64), validationTraceSha256: "c".repeat(64), validationCases: 2, passedCases: 2 };
const proposal = (skillId = "A", overrides = {}) => ({ skillId, description: `Skill ${skillId}`, program, toolNames: ["write"], learningEvidence, ...overrides });
const empty = () => emptySkillLibrary({ modelIdentity });
const clone = value => JSON.parse(JSON.stringify(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const rehash = value => { const { digest: _digest, ...body } = value; return { ...body, digest: createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex") }; };
const libraryUrl = new URL("../src/persistentSkillLibrary.js", import.meta.url).href;
const procedureUrl = new URL("../src/checkedProcedure.js", import.meta.url).href;

async function directory(t) {
  const path = await fs.mkdtemp(join(tmpdir(), "amos-skill-library-"));
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  return path;
}

test("empty snapshots are deterministic, detached, serializable and deeply immutable", () => {
  const input = { modelIdentity: { ...modelIdentity } };
  const library = emptySkillLibrary(input);
  input.modelIdentity.model = "changed input";
  assert.equal(library.modelIdentity.model, modelIdentity.model);
  assert.equal(library.parentDigest, null);
  assert.deepEqual(library.entries, []);
  assert.deepEqual(validateSkillLibrary(clone(library)), library);
  assert.equal(empty().digest, library.digest);
  assert.throws(() => { library.modelIdentity.model = "changed output"; }, TypeError);
  assert.throws(() => library.entries.push({}), TypeError);
});

test("A to B admission appends immutably and preserves A program, evidence and entry hashes", () => {
  const baseline = empty(), a = admitCheckedSkill(baseline, proposal());
  const aBytes = JSON.stringify(a);
  const b = admitCheckedSkill(a, proposal("B", { description: "A complementary reusable skill" }));
  assert.deepEqual(b.entries.map(entry => entry.skillId), ["A", "B"]);
  assert.equal(a.parentDigest, baseline.digest);
  assert.equal(b.parentDigest, a.digest);
  assert.deepEqual(b.entries[0], a.entries[0]);
  assert.equal(JSON.stringify(a), aBytes);
  assert.deepEqual(validateSkillLibrary(b, { parentLibrary: a }), b);
  assert.throws(() => { b.entries[0].program.steps[0].tool = "wrong"; }, TypeError);
  assert.throws(() => admitCheckedSkill(a, proposal("A", { description: "Overwrite A" })), /already exists/);
  assert.equal(JSON.stringify(a), aBytes);
});

test("admission rejects missing, zero, partial, fractional and unbound validation evidence", () => {
  for (const evidence of [null, { ...learningEvidence, validationCases: 0, passedCases: 0 },
    { ...learningEvidence, passedCases: 1 }, { ...learningEvidence, validationCases: 1.5, passedCases: 1.5 },
    { ...learningEvidence, validationCases: -2, passedCases: -2 }, { ...learningEvidence, validationTraceSha256: "missing" },
    { ...learningEvidence, demonstrationsSha256: null }]) {
    assert.throws(() => admitCheckedSkill(empty(), proposal("A", { learningEvidence: evidence })));
  }
});

test("program validation rejects unknown tools, malicious refs and programs beyond agreed limits", () => {
  assert.throws(() => admitCheckedSkill(empty(), proposal("A", { toolNames: [] })), /unknown tool/);
  const malicious = clone(program); malicious.steps[0].args.title.$ref = "goal.__proto__.title";
  assert.throws(() => admitCheckedSkill(empty(), proposal("A", { program: malicious })), /reference/);
  const tooWide = { schema: program.schema, steps: Array.from({ length: 513 }, () => ({ type: "return", status: "completed" })) };
  assert.throws(() => admitCheckedSkill(empty(), proposal("A", { program: tooWide })), /maxNodes/);
  let nested = [{ type: "return", status: "completed" }];
  for (let depth = 0; depth < 8; depth++) nested = [{ type: "if", left: true, equals: true, then: nested }];
  assert.throws(() => admitCheckedSkill(empty(), proposal("A", { program: { schema: program.schema, steps: nested } })), /maxDepth/);
  const wideAllowed = { schema: program.schema, steps: Array.from({ length: 130 }, () => ({ type: "return", status: "completed" })) };
  assert.equal(admitCheckedSkill(empty(), proposal("A", { program: wideAllowed })).entries[0].program.steps.length, 130);
});

test("tampering with programs, receipts, descriptions, entry hashes or the snapshot is rejected", () => {
  const original = admitCheckedSkill(empty(), proposal());
  const mutations = [
    x => { x.entries[0].program.steps[1].status = "needs_reasoning"; },
    x => { x.entries[0].learningEvidence.validationTraceSha256 = "d".repeat(64); },
    x => { x.entries[0].description = "Different"; },
    x => { x.entries[0].digest = "0".repeat(64); },
    x => { x.parentDigest = "e".repeat(64); },
    x => { x.digest = "f".repeat(64); }
  ];
  for (const mutate of mutations) { const changed = clone(original); mutate(changed); assert.throws(() => validateSkillLibrary(changed), /hash mismatch/); }
  const changed = clone(original); changed.entries[0].program.steps[0].tool = "not-admitted";
  assert.throws(() => validateSkillLibrary(rehash(changed)), /unknown tool/);
});

test("model identities cannot be merged and supplied parent verifies exact continuity", () => {
  const a = admitCheckedSkill(empty(), proposal());
  const otherEmpty = emptySkillLibrary({ modelIdentity: { model: "other", weightsSha256: "f".repeat(64) } });
  const other = admitCheckedSkill(otherEmpty, proposal("B"));
  const mixed = rehash({ ...clone(a), entries: [other.entries[0]] });
  assert.throws(() => validateSkillLibrary(mixed), /model identity/);
  assert.throws(() => validateSkillLibrary(other, { parentLibrary: empty() }), /Parent model identity/);
  assert.throws(() => admitCheckedSkill(a, { ...proposal("B"), modelIdentity: other.modelIdentity }), /unexpected fields/);
  const b = admitCheckedSkill(a, proposal("B"));
  assert.throws(() => validateSkillLibrary(b, { parentLibrary: empty() }), /Parent digest/);
  const reordered = rehash({ ...clone(b), entries: [...b.entries].reverse() });
  assert.throws(() => validateSkillLibrary(reordered, { parentLibrary: a }), /without rewriting/);
});

test("standalone validation checks a parent digest reference, not the existence of its history", () => {
  const a = admitCheckedSkill(empty(), proposal());
  const unattested = rehash({ ...a, parentDigest: "e".repeat(64) });
  assert.equal(validateSkillLibrary(unattested).parentDigest, "e".repeat(64));
  assert.throws(() => validateSkillLibrary(unattested, { parentLibrary: empty() }), /Parent digest/);
});

test("malformed objects and getters are rejected without invoking user code", () => {
  let invoked = false;
  const badIdentity = { weightsSha256: "a".repeat(64), get model() { invoked = true; return "bad"; } };
  assert.throws(() => emptySkillLibrary({ modelIdentity: badIdentity }), /data properties/);
  assert.equal(invoked, false);
  assert.throws(() => emptySkillLibrary({ modelIdentity: Object.create(modelIdentity) }));
  assert.throws(() => admitCheckedSkill(empty(), proposal("__proto__")));
  assert.throws(() => admitCheckedSkill(empty(), proposal("A", { toolNames: [, "write"] })));
  const malicious = JSON.parse('{"schema":"amos.checked-procedure.v1","steps":[],"__proto__":{}}');
  assert.throws(() => admitCheckedSkill(empty(), proposal("A", { program: malicious })));
});

test("save and load preserve every hash, accept identical bytes, and refuse an existing different snapshot", async t => {
  const dir = await directory(t), path = join(dir, "snapshot.json");
  const a = admitCheckedSkill(empty(), proposal()), b = admitCheckedSkill(a, proposal("B"));
  assert.equal(await saveSkillLibrary(path, a), path);
  const bytes = await fs.readFile(path);
  assert.equal(await saveSkillLibrary(path, clone(a)), path);
  assert.deepEqual(await loadSkillLibrary(path), a);
  await assert.rejects(saveSkillLibrary(path, b), /Refusing to overwrite/);
  assert.deepEqual(await fs.readFile(path), bytes);
  const corrupt = JSON.parse(bytes); corrupt.entries[0].description = "disk corruption";
  await fs.writeFile(path, JSON.stringify(corrupt));
  await assert.rejects(loadSkillLibrary(path), /hash mismatch/);
});

test("concurrent writers cannot replace one another's snapshot", async t => {
  const dir = await directory(t), path = join(dir, "race.json");
  const a = admitCheckedSkill(empty(), proposal()), b = admitCheckedSkill(empty(), proposal("B"));
  const results = await Promise.allSettled([saveSkillLibrary(path, a), saveSkillLibrary(path, b)]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  const actual = await loadSkillLibrary(path);
  assert.ok([a.digest, b.digest].includes(actual.digest));
  const identical = await Promise.all([saveSkillLibrary(path, actual), saveSkillLibrary(path, actual)]);
  assert.deepEqual(identical, [path, path]);
});

test("load rejects symlink and nonregular paths and save cannot overwrite through a symlink", async t => {
  const dir = await directory(t), actual = join(dir, "actual.json"), link = join(dir, "alias.json");
  await saveSkillLibrary(actual, empty()); await fs.symlink(actual, link);
  await assert.rejects(loadSkillLibrary(link));
  await assert.rejects(saveSkillLibrary(link, empty()));
  await assert.rejects(loadSkillLibrary(dir), /regular file/);
  await assert.rejects(saveSkillLibrary("relative.json", empty()), /absolute/);
  await fs.writeFile(join(dir, "torn.json"), '{"schema":');
  await assert.rejects(loadSkillLibrary(join(dir, "torn.json")), SyntaxError);
});

test("a fresh Node process reloads the persisted program and executes with new public goal data", { timeout: 15_000 }, async t => {
  const dir = await directory(t), path = join(dir, "accepted-A.json"), a = admitCheckedSkill(empty(), proposal());
  await saveSkillLibrary(path, a);
  const code = `import { loadSkillLibrary } from ${JSON.stringify(libraryUrl)};
    import { executeCheckedProcedure } from ${JSON.stringify(procedureUrl)};
    const library=await loadSkillLibrary(${JSON.stringify(path)}); const skill=library.entries[0]; const writes=[];
    const result=await executeCheckedProcedure(skill.program,{goal:{title:'fresh task after restart'},getState:()=>({}),
      executeTool:async(name,args)=>{writes.push({name,args});return {ok:true};},toolNames:skill.toolNames,maxNodes:512,maxDepth:8});
    console.log(JSON.stringify({digest:library.digest,programSha256:skill.programSha256,writes,status:result.status}));`;
  const child = spawn(process.execPath, ["--input-type=module"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = ""; child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
  child.stdin.end(code); const [exitCode] = await once(child, "exit");
  assert.equal(exitCode, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.digest, a.digest); assert.equal(result.programSha256, a.entries[0].programSha256);
  assert.equal(result.status, "completed");
  assert.deepEqual(result.writes, [{ name: "write", args: { title: "fresh task after restart" } }]);
});

test("a process interrupted before exclusive publication leaves no torn snapshot and preserves its parent", { timeout: 15_000 }, async t => {
  const dir = await directory(t), parentPath = join(dir, "accepted-A.json"), childPath = join(dir, "accepted-B.json");
  const a = admitCheckedSkill(empty(), proposal()), b = admitCheckedSkill(a, proposal("B"));
  await saveSkillLibrary(parentPath, a);
  const code = `import fs from 'node:fs/promises';
    import { saveSkillLibrary } from ${JSON.stringify(libraryUrl)};
    fs.link=async(source,destination)=>{console.log(JSON.stringify({source,destination}));await new Promise(()=>setInterval(()=>{},1000));};
    await saveSkillLibrary(${JSON.stringify(childPath)},${JSON.stringify(b)});`;
  const child = spawn(process.execPath, ["--input-type=module"], { stdio: ["pipe", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const lines = createInterface({ input: child.stdout });
  const ready = once(lines, "line"); child.stdin.end(code);
  const [line] = await ready; const staged = JSON.parse(line);
  assert.equal(staged.destination, childPath);
  assert.equal(JSON.parse(await fs.readFile(staged.source, "utf8")).digest, b.digest);
  await assert.rejects(fs.stat(childPath), { code: "ENOENT" });
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; lines.close();
  assert.deepEqual(await loadSkillLibrary(parentPath), a);
  await assert.rejects(loadSkillLibrary(childPath), { code: "ENOENT" });
  await saveSkillLibrary(childPath, b);
  assert.deepEqual(await loadSkillLibrary(childPath), b);
});
