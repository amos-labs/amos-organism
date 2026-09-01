import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { digest, immutable } from "./digest.ts";

export interface OrganismEventProposal {
  readonly id: string;
  readonly type: string;
  readonly missionId: string;
  readonly occurredAt: string;
  readonly authority: "host" | "organism";
  readonly hostReceiptId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface OrganismEvent extends OrganismEventProposal {
  readonly sequence: number;
  readonly previousDigest: string | null;
  readonly digest: string;
}

export interface EventStore {
  append(proposal: OrganismEventProposal): OrganismEvent;
  get(id: string): OrganismEvent | undefined;
  events(): readonly OrganismEvent[];
}

export class DuplicateOrganismEventError extends Error {
  readonly eventId: string;

  constructor(eventId: string) {
    super(`Duplicate organism event: ${eventId}`);
    this.name = "DuplicateOrganismEventError";
    this.eventId = eventId;
  }
}

/**
 * Durable JSONL hash chain. It is a single-writer research store; production
 * adapters should provide equivalent transactional ordering in DynamoDB.
 */
export class FileEventStore implements EventStore {
  readonly #path: string;
  readonly #events: OrganismEvent[];

  constructor(path: string) {
    this.#path = path;
    this.#events = existsSync(path) ? readAndVerify(path) : [];
  }

  append(proposal: OrganismEventProposal): OrganismEvent {
    if (this.#events.some((event) => event.id === proposal.id)) {
      throw new DuplicateOrganismEventError(proposal.id);
    }
    const sequence = this.#events.length + 1;
    const previousDigest = this.#events.at(-1)?.digest ?? null;
    const body = { ...proposal, sequence, previousDigest };
    const event = immutable({ ...body, digest: digest(body) });
    mkdirSync(dirname(this.#path), { recursive: true });
    const descriptor = openSync(this.#path, "a", 0o600);
    try {
      writeSync(descriptor, `${JSON.stringify(event)}\n`, undefined, "utf8");
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    this.#events.push(event);
    return event;
  }

  events(): readonly OrganismEvent[] {
    return immutable(this.#events);
  }

  get(id: string): OrganismEvent | undefined {
    return this.#events.find((event) => event.id === id);
  }
}

export class MemoryEventStore implements EventStore {
  readonly #events: OrganismEvent[] = [];

  append(proposal: OrganismEventProposal): OrganismEvent {
    if (this.#events.some((event) => event.id === proposal.id)) {
      throw new DuplicateOrganismEventError(proposal.id);
    }
    const sequence = this.#events.length + 1;
    const previousDigest = this.#events.at(-1)?.digest ?? null;
    const body = { ...proposal, sequence, previousDigest };
    const event = immutable({ ...body, digest: digest(body) });
    this.#events.push(event);
    return event;
  }

  events(): readonly OrganismEvent[] {
    return immutable(this.#events);
  }

  get(id: string): OrganismEvent | undefined {
    return this.#events.find((event) => event.id === id);
  }
}

function readAndVerify(path: string): OrganismEvent[] {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const events: OrganismEvent[] = [];
  for (const [index, line] of lines.entries()) {
    const parsed = JSON.parse(line) as OrganismEvent;
    const expectedSequence = index + 1;
    const expectedPrevious = events.at(-1)?.digest ?? null;
    const { digest: recordedDigest, ...body } = parsed;
    if (parsed.sequence !== expectedSequence) {
      throw new Error(`Invalid organism event sequence at line ${expectedSequence}`);
    }
    if (parsed.previousDigest !== expectedPrevious) {
      throw new Error(`Broken organism event chain at line ${expectedSequence}`);
    }
    if (digest(body) !== recordedDigest) {
      throw new Error(`Invalid organism event digest at line ${expectedSequence}`);
    }
    events.push(immutable(parsed));
  }
  return events;
}
