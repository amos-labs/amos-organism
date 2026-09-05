# Platform Episode Intake

The private endpoint that turns consented Platform Mission outcomes into
organism experience. It is the transport half of the boundary described in the
Platform's organism learning handoff; the kernel half is `PlatformEpisodeIntake`.

## What the Platform sends

The Platform's delivery worker POSTs the canonical JSON episode body and puts
every attestation detail in headers:

| Header | Content |
|---|---|
| `idempotency-key` | the deterministic episode id |
| `x-amos-attestation-receipt` | the Platform's immutable attestation receipt id |
| `x-amos-kms-key-id` | the KMS key that signed |
| `x-amos-kms-signing-algorithm` | `ECDSA_SHA_256` by default |
| `x-amos-kms-signature` | base64 DER signature of the body's SHA-256 digest |
| `authorization` | optional `Bearer` token |

## What the receiver does, in order

1. Rejects a bearer mismatch, an oversized body, an unexpected key id, or a
   disallowed algorithm before reading the body.
2. Parses the body, checks the episode contract, and checks that the idempotency
   key is the episode id.
3. Recomputes SHA-256 over the raw bytes and requires it to equal the kernel's
   canonical digest of the parsed episode. Non-canonical bytes are refused even
   when they would parse to the same object.
4. Verifies the KMS signature over the raw bytes with the configured public key.
5. Only then mints a host receipt of kind `platform-episode-attested` and hands
   the episode to the kernel intake, which applies its own digest, identity, and
   consent checks and appends an idempotent event.

Responses: 200 accepted or duplicate, 400 malformed, 401 unauthenticated or
unverifiable, 409 conflicting retry, 413 too large. No event is written on any
non-200 path.

## Running it

```bash
aws kms get-public-key --key-id "$KMS_KEY_ID" --query PublicKey --output text > organism-kms-public-key.der.b64

AMOS_ORGANISM_INTAKE_BEARER_TOKEN="$TOKEN" npm run organism:serve-platform-intake -- \
  --events .amos-organism/platform-events.jsonl \
  --kms-key-id "$KMS_KEY_ID" \
  --public-key organism-kms-public-key.der.b64 \
  --host 0.0.0.0 --port 8787
```

On the Platform side, set:

```
AMOS__ORGANISM__EPISODE_ENDPOINT=https://<private-host>/v1/platform/episodes
AMOS__ORGANISM__KMS_KEY_ID=<same key>
AMOS__ORGANISM__BEARER_TOKEN=<same token>
```

## Deployment notes

- The service binds privately. Put it behind the Platform VPC or a private load
  balancer; it has no reason to be reachable from the internet.
- The event store is the single-writer JSONL hash chain. Run one instance per
  events file. The DynamoDB projection remains future work.
- Consent is enforced upstream: the Platform produces no episode for a tenant
  without a live learning policy. This service cannot widen that.
- Gene admission stays disabled on every event this path writes. Ingested
  episodes are experience, not procedures.

## Compatibility fixture (shared with the Platform and Codex lanes)

`test/fixtures/platform-episode-delivery.v1.json` records nine deliveries to
the intake as exact body bytes plus the X-Amos headers and the outcome the
reference receiver must produce: verified completed episode, duplicate
redelivery, typed failure (negative experience), tampered bytes, non-canonical
bytes, forged signature, wrong key id, disallowed algorithm, idempotency
mismatch. Replay them in order against one receiver configured with
`publicKeyDerBase64` (the KMS GetPublicKey SPKI DER form) and `keyId`. The
producer side of the fixture is `platform-mission-episode.producer.json`,
mirrored from the Platform's `build_episode_body`. Regenerate with
`npm run organism:generate-episode-fixture`; the fixture-only signing keys
live beside it and sign nothing outside tests. `test/platformEpisodeDeliveryFixture.test.ts`
replays the fixture on every test run.

