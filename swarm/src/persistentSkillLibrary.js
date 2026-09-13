import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { validateCheckedProcedure } from "./checkedProcedure.js";

export const SKILL_LIBRARY_SCHEMA = "amos.persistent-skill-library.v1";
const SKILL_SCHEMA = "amos.persisted-checked-skill.v1";
const PROCEDURE_LIMITS = { maxNodes: 512, maxDepth: 8 };
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Entries are an insertion-ordered array; hashes use canonical JSON, not file formatting. */
export function emptySkillLibrary(input) {
  const { modelIdentity } = fields(input, ["modelIdentity"], "options");
  return snapshot({ schema: SKILL_LIBRARY_SCHEMA, modelIdentity: identity(modelIdentity), parentDigest: null, entries: [] });
}

/** Admission binds caller-supplied host receipts. It does not itself run or authenticate validation. */
export function admitCheckedSkill(input, proposal) {
  const parent = validateSkillLibrary(input);
  const source = fields(proposal,
    ["skillId", "description", "program", "toolNames", "learningEvidence"], "skill proposal");
  const skillId = identifier(source.skillId, "skillId");
  if (parent.entries.some(entry => entry.skillId === skillId)) throw new Error(`Skill ID already exists: ${skillId}`);
  const toolNames = normalizeTools(source.toolNames);
  const program = validateCheckedProcedure(source.program, { toolNames, ...PROCEDURE_LIMITS });
  const learningEvidence = evidence(source.learningEvidence);
  const entry = withDigest({
    schema: SKILL_SCHEMA, skillId, description: text(source.description, "description"),
    modelIdentity: parent.modelIdentity, program, programSha256: hash(program), toolNames,
    learningEvidence, evidenceSha256: hash(learningEvidence)
  });
  const child = snapshot({ schema: SKILL_LIBRARY_SCHEMA, modelIdentity: parent.modelIdentity,
    parentDigest: parent.digest, entries: [...parent.entries, entry] });
  return validateSkillLibrary(child, { parentLibrary: parent });
}

/** Verify local content hashes and procedure admission, returning detached immutable data.
 * A parent digest alone does not attest historical ancestry. Supplying parentLibrary
 * additionally checks that this snapshot appends exactly one skill to that direct parent.
 */
export function validateSkillLibrary(input, { parentLibrary } = {}) {
  const source = fields(input, ["schema", "modelIdentity", "parentDigest", "entries", "digest"], "library");
  if (source.schema !== SKILL_LIBRARY_SCHEMA) throw new Error("Unsupported skill library schema");
  const modelIdentity = identity(source.modelIdentity);
  const rawEntries = array(source.entries, "entries");
  if (rawEntries.length === 0 ? source.parentDigest !== null : source.parentDigest === null) {
    throw new Error("Only the empty library has a null parentDigest");
  }
  if (source.parentDigest !== null) sha256(source.parentDigest, "parentDigest");
  const ids = new Set();
  const entries = rawEntries.map(raw => {
    const entry = fields(raw, ["schema", "skillId", "description", "modelIdentity", "program", "programSha256",
      "toolNames", "learningEvidence", "evidenceSha256", "digest"], "entry");
    if (entry.schema !== SKILL_SCHEMA) throw new Error("Unsupported checked skill schema");
    const skillId = identifier(entry.skillId, "skillId");
    if (ids.has(skillId)) throw new Error(`Duplicate skill ID: ${skillId}`);
    ids.add(skillId);
    const entryIdentity = identity(entry.modelIdentity);
    if (hash(entryIdentity) !== hash(modelIdentity)) throw new Error("Skill model identity does not match its library");
    const toolNames = normalizeTools(entry.toolNames);
    if (JSON.stringify(toolNames) !== JSON.stringify(entry.toolNames)) throw new Error("Stored toolNames must be sorted and unique");
    const program = validateCheckedProcedure(entry.program, { toolNames, ...PROCEDURE_LIMITS });
    const learningEvidence = evidence(entry.learningEvidence);
    if (sha256(entry.programSha256, "programSha256") !== hash(program)) throw new Error("Skill program hash mismatch");
    if (sha256(entry.evidenceSha256, "evidenceSha256") !== hash(learningEvidence)) throw new Error("Skill evidence hash mismatch");
    const normalized = withDigest({ schema: SKILL_SCHEMA, skillId, description: text(entry.description, "description"),
      modelIdentity: entryIdentity, program, programSha256: entry.programSha256, toolNames,
      learningEvidence, evidenceSha256: entry.evidenceSha256 });
    if (sha256(entry.digest, "entry.digest") !== normalized.digest) throw new Error("Skill entry hash mismatch");
    return normalized;
  });
  const validated = snapshot({ schema: SKILL_LIBRARY_SCHEMA, modelIdentity, parentDigest: source.parentDigest, entries });
  if (sha256(source.digest, "library.digest") !== validated.digest) throw new Error("Skill library hash mismatch");
  if (source.parentDigest === source.digest) throw new Error("Library cannot name itself as parent");
  if (parentLibrary !== undefined) {
    const parent = validateSkillLibrary(parentLibrary);
    if (hash(parent.modelIdentity) !== hash(modelIdentity)) throw new Error("Parent model identity differs");
    if (source.parentDigest !== parent.digest) throw new Error("Parent digest does not match supplied snapshot");
    if (entries.length !== parent.entries.length + 1 ||
        parent.entries.some((entry, index) => entry.digest !== entries[index].digest)) {
      throw new Error("Child must append one skill without rewriting its parent entries");
    }
  }
  return validated;
}

/** Publish with an exclusive hard link after flushing a same-directory temporary file.
 * Existing files are accepted only when byte-identical. No rename overwrites a snapshot.
 */
export async function saveSkillLibrary(filePath, input) {
  const destination = absolutePath(filePath);
  const library = validateSkillLibrary(input);
  const bytes = Buffer.from(canonical(library) + "\n");
  if (bytes.length > MAX_FILE_BYTES) throw new Error("Skill library exceeds file size limit");
  const directory = dirname(destination);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = resolve(directory, `.${basename(destination)}.${randomUUID()}.tmp`);
  let handle, created = false;
  try {
    handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    try { await fs.link(temporary, destination); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readRegularFile(destination);
      if (!existing.equals(bytes)) throw new Error("Refusing to overwrite a different skill library snapshot");
    }
    const directoryHandle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
    try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    return destination;
  } finally {
    try { if (handle) await handle.close(); }
    finally { if (created) await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }
}

export async function loadSkillLibrary(filePath) {
  return validateSkillLibrary(JSON.parse((await readRegularFile(absolutePath(filePath))).toString("utf8")));
}

async function readRegularFile(filePath) {
  const handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Skill library must be a bounded regular file");
    const bytes = await handle.readFile();
    if (bytes.length > MAX_FILE_BYTES) throw new Error("Skill library exceeds file size limit");
    return bytes;
  } finally { await handle.close(); }
}

function identity(input) {
  const value = fields(input, ["model", "weightsSha256"], "modelIdentity");
  return { model: text(value.model, "modelIdentity.model"), weightsSha256: sha256(value.weightsSha256, "modelIdentity.weightsSha256") };
}

function evidence(input) {
  const value = fields(input, ["demonstrationsSha256", "validationTraceSha256", "validationCases", "passedCases"], "learningEvidence");
  if (!Number.isSafeInteger(value.validationCases) || value.validationCases <= 0 || value.passedCases !== value.validationCases) {
    throw new Error("Skill requires positive validationCases with every case passed");
  }
  return { demonstrationsSha256: sha256(value.demonstrationsSha256, "demonstrationsSha256"),
    validationTraceSha256: sha256(value.validationTraceSha256, "validationTraceSha256"),
    validationCases: value.validationCases, passedCases: value.passedCases };
}

function normalizeTools(input) {
  return [...new Set(array(input, "toolNames").map(name => identifier(name, "tool name")))].sort();
}

function fields(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new TypeError(`${label} must be a plain object`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== expected.length || expected.some(key => !Object.hasOwn(descriptors, key))) {
    throw new TypeError(`${label} has missing or unexpected fields`);
  }
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (UNSAFE_KEYS.has(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
      throw new TypeError(`${label} must contain safe JSON data properties`);
    }
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function array(value, label) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) {
    throw new TypeError(`${label} must be a dense JSON array`);
  }
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${label} must contain data entries`);
  }
  return value;
}

function text(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be nonempty text`);
  return value;
}

function identifier(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) || UNSAFE_KEYS.has(value)) {
    throw new TypeError(`${label} must be a safe identifier`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} must be a lowercase SHA-256`);
  return value;
}

function absolutePath(value) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TypeError("Skill library path must be absolute");
  return resolve(value);
}

function canonical(value) {
  const sorted = item => Array.isArray(item) ? item.map(sorted) : item && typeof item === "object"
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, sorted(item[key])])) : item;
  return JSON.stringify(sorted(value));
}

function hash(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function withDigest(value) { return { ...value, digest: hash(value) }; }
function snapshot(value) { return freeze(withDigest(value)); }
function freeze(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
