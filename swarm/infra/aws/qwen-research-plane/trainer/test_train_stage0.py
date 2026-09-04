import importlib.util
import tempfile
import unittest
from collections import UserDict
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("train_stage0.py")
SPEC = importlib.util.spec_from_file_location("amos_train_stage0", MODULE_PATH)
TRAINER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(TRAINER)


class FakeTokenizer:
    def apply_chat_template(self, messages, **kwargs):
        if len(messages) == 2 and kwargs.get("add_generation_prompt"):
            return [10, 11, 12]
        if len(messages) == 3 and not kwargs.get("add_generation_prompt"):
            return [10, 11, 12, 20, 21]
        raise AssertionError("unexpected chat-template call")


class DriftedTokenizer(FakeTokenizer):
    def apply_chat_template(self, messages, **kwargs):
        if len(messages) == 3:
            return [99, 20]
        return super().apply_chat_template(messages, **kwargs)


class BatchEncodingTokenizer(FakeTokenizer):
    def apply_chat_template(self, messages, **kwargs):
        input_ids = super().apply_chat_template(messages, **kwargs)
        return UserDict({"input_ids": input_ids, "attention_mask": [1] * len(input_ids)})


ROW = {
    "messages": [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "user"},
        {"role": "assistant", "content": "target"},
    ],
    "metadata": {"exampleId": "example-1"},
}


class StageZeroTrainerTests(unittest.TestCase):
    def _contract(self, purpose, stage, **overrides):
        contract = {
            "schema": "amos.qwen-adapter-training-contract",
            "version": 1,
            "id": "contract-under-test",
            "purpose": purpose,
            "qualityClaimAllowed": False,
            "promotionAllowed": False,
            "recipe": {
                "stage": stage,
                "optimization": {"loss": "assistant-tokens-only"},
                "includeVisionTowerInAdapter": False,
            },
            "selection": {"trainerMayNotSelect": True},
            "execution": {"liveInferenceEndpointMutable": False, "torchNativeJitDisabled": True},
        }
        contract.update(overrides)
        contract["digest"] = TRAINER.digest_value({k: v for k, v in contract.items() if k != "digest"})
        return contract

    def test_validate_contract_accepts_stage_zero_proof_and_stage_one_sft(self):
        TRAINER.validate_contract(self._contract("pipeline-and-lineage-proof", 0))
        TRAINER.validate_contract(self._contract("amos-system-competence-sft", 1))

    def test_validate_contract_rejects_unknown_stage_quality_claims_and_self_selection(self):
        with self.assertRaises(ValueError):
            TRAINER.validate_contract(self._contract("amos-system-competence-sft", 2))
        with self.assertRaises(ValueError):
            TRAINER.validate_contract(self._contract("pipeline-and-lineage-proof", 1))
        with self.assertRaises(ValueError):
            TRAINER.validate_contract(self._contract("amos-system-competence-sft", 1, qualityClaimAllowed=True))
        with self.assertRaises(ValueError):
            TRAINER.validate_contract(self._contract("amos-system-competence-sft", 1, selection={"trainerMayNotSelect": False}))

    def test_upstream_tree_retries_rate_limits_then_succeeds(self):
        import io
        import urllib.error
        calls = {"n": 0}

        class Response(io.StringIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def opener(request, timeout):
            calls["n"] += 1
            if calls["n"] < 3:
                raise urllib.error.HTTPError(request.full_url, 429, "Too Many Requests", {"Retry-After": "0"}, None)
            return Response('[{"type":"file","path":"x"}]')

        base = {"repository": "Qwen/Qwen3.8-27B", "revision": "a" * 40}
        tree = TRAINER.fetch_upstream_tree(base, attempts=4, opener=opener)
        self.assertEqual(tree, [{"type": "file", "path": "x"}])
        self.assertEqual(calls["n"], 3)

    def test_upstream_lineage_reuses_matching_cached_receipt(self):
        base = {"repository": "Qwen/Qwen3.8-27B", "revision": "a" * 40, "checkpointDigest": "b" * 64, "expectedShardDigests": [{}] * 18}
        receipt = {
            "schema": "amos.qwen-upstream-lineage-receipt", "version": 1,
            "repository": base["repository"], "revision": base["revision"],
            "checkpointDigest": base["checkpointDigest"], "verifiedShards": 18, "status": "passed",
        }
        receipt["digest"] = TRAINER.digest_value(receipt)
        with tempfile.TemporaryDirectory() as root:
            cached = Path(root) / "upstream-lineage-receipt.json"
            cached.write_text(__import__("json").dumps(receipt), encoding="utf-8")
            self.assertEqual(TRAINER.verify_upstream_lineage(base, cached=cached), receipt)
            drifted = dict(receipt, revision="c" * 40)
            drifted["digest"] = TRAINER.digest_value({k: v for k, v in drifted.items() if k != "digest"})
            cached.write_text(__import__("json").dumps(drifted), encoding="utf-8")
            original = TRAINER.fetch_upstream_tree
            TRAINER.fetch_upstream_tree = lambda base_arg, **kwargs: (_ for _ in ()).throw(RuntimeError("network disabled in test"))
            try:
                with self.assertRaisesRegex(RuntimeError, "network disabled"):
                    TRAINER.verify_upstream_lineage(base, cached=cached)
            finally:
                TRAINER.fetch_upstream_tree = original

    def test_digest_matches_javascript_canonical_research_digest(self):
        value = {"b": [True, 0.0002, "AMOS"], "a": {"z": None, "n": 64}}
        self.assertEqual(
            TRAINER.digest_value(value),
            "48eeb8f6293433064c45652db6614fdd74d793236181573568d75a598293bbf0",
        )

    def test_encode_masks_prompt_and_supervises_only_assistant_tokens(self):
        encoded = TRAINER.encode_example(FakeTokenizer(), ROW, 32)
        self.assertEqual(encoded["input_ids"], [10, 11, 12, 20, 21])
        self.assertEqual(
            encoded["labels"],
            [TRAINER.IGNORE_INDEX, TRAINER.IGNORE_INDEX, TRAINER.IGNORE_INDEX, 20, 21],
        )

    def test_encode_fails_closed_if_chat_template_boundary_drifts(self):
        with self.assertRaisesRegex(ValueError, "loss boundary"):
            TRAINER.encode_example(DriftedTokenizer(), ROW, 32)

    def test_encode_normalizes_transformers_five_batch_encoding_shape(self):
        encoded = TRAINER.encode_example(BatchEncodingTokenizer(), ROW, 32)
        self.assertEqual(encoded["input_ids"], [10, 11, 12, 20, 21])
        self.assertEqual(encoded["labels"][-2:], [20, 21])

    def test_file_receipt_checks_digest_rows_and_size(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.jsonl"
            path.write_text('{"a":1}\n{"a":2}\n', encoding="utf-8")
            digest = TRAINER.file_sha256(path)
            TRAINER.verify_file(path, digest, 2, path.stat().st_size)
            with self.assertRaisesRegex(ValueError, "row-count mismatch"):
                TRAINER.verify_file(path, digest, 3)


if __name__ == "__main__":
    unittest.main()
