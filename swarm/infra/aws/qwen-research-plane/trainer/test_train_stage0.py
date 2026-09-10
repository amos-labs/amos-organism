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


class ToolTraceTokenizer(FakeTokenizer):
    """Renders a multi-turn tool trace: three masked context turns then the
    supervised final assistant target. Records every apply_chat_template call
    so the test can assert row.tools is forwarded."""

    def __init__(self):
        self.calls = []

    def apply_chat_template(self, messages, **kwargs):
        self.calls.append(
            {
                "count": len(messages),
                "add_generation_prompt": kwargs.get("add_generation_prompt"),
                "tools": kwargs.get("tools"),
            }
        )
        if len(messages) == 3 and kwargs.get("add_generation_prompt"):
            return [10, 11, 12, 13]
        if len(messages) == 4 and not kwargs.get("add_generation_prompt"):
            return [10, 11, 12, 13, 30, 31]
        raise AssertionError("unexpected chat-template call")


class ToolKwargSpyTokenizer(FakeTokenizer):
    """Legacy-row guard: records whether a tools keyword ever reached the
    pinned chat template so tool-free rows can be proven to render as before."""

    def __init__(self):
        self.saw_tools_kwarg = False

    def apply_chat_template(self, messages, **kwargs):
        if "tools" in kwargs:
            self.saw_tools_kwarg = True
        return super().apply_chat_template(messages, **kwargs)


TOOL_ROW = {
    "messages": [
        {"role": "system", "content": "system"},
        {"role": "user", "content": "compute 21 + 21"},
        {"role": "tool", "content": "result=42"},
        {"role": "assistant", "content": "the answer is 42"},
    ],
    "tools": [{"type": "function", "function": {"name": "calc"}}],
    "metadata": {"exampleId": "tool-1"},
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

    def test_encode_tool_trace_masks_context_and_supervises_only_final_assistant(self):
        encoded = TRAINER.encode_example(ToolTraceTokenizer(), TOOL_ROW, 32)
        self.assertEqual(encoded["input_ids"], [10, 11, 12, 13, 30, 31])
        # System, user and tool-result context are masked; only the final
        # assistant target tokens are supervised.
        self.assertEqual(
            encoded["labels"],
            [
                TRAINER.IGNORE_INDEX,
                TRAINER.IGNORE_INDEX,
                TRAINER.IGNORE_INDEX,
                TRAINER.IGNORE_INDEX,
                30,
                31,
            ],
        )

    def test_encode_forwards_row_tools_to_chat_template(self):
        tokenizer = ToolTraceTokenizer()
        TRAINER.encode_example(tokenizer, TOOL_ROW, 32)
        self.assertTrue(tokenizer.calls)
        self.assertTrue(
            all(call["tools"] == TOOL_ROW["tools"] for call in tokenizer.calls)
        )

    def test_encode_does_not_pass_tools_for_tool_free_rows(self):
        tokenizer = ToolKwargSpyTokenizer()
        TRAINER.encode_example(tokenizer, ROW, 32)
        self.assertFalse(tokenizer.saw_tools_kwarg)

    def test_encode_rejects_row_whose_final_message_is_not_assistant(self):
        row = {
            "messages": [
                {"role": "system", "content": "system"},
                {"role": "user", "content": "user"},
            ]
        }
        with self.assertRaisesRegex(ValueError, "final SFT row message"):
            TRAINER.encode_example(FakeTokenizer(), row, 32)

    def test_encode_rejects_unknown_message_role(self):
        row = {
            "messages": [
                {"role": "system", "content": "system"},
                {"role": "reviewer", "content": "nope"},
                {"role": "assistant", "content": "target"},
            ]
        }
        with self.assertRaisesRegex(ValueError, "message role"):
            TRAINER.encode_example(FakeTokenizer(), row, 32)

    def test_file_receipt_checks_digest_rows_and_size(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.jsonl"
            path.write_text('{"a":1}\n{"a":2}\n', encoding="utf-8")
            digest = TRAINER.file_sha256(path)
            TRAINER.verify_file(path, digest, 2, path.stat().st_size)
            with self.assertRaisesRegex(ValueError, "row-count mismatch"):
                TRAINER.verify_file(path, digest, 3)


class ParentInitializationTests(unittest.TestCase):
    PARENT = {
        "adapterUri": "s3://amos-qwen-research-plane-637423327454-us-east-1/stage1/pilot-2026-09-09/runs/pilot-060909-r32-s20260909/adapter",
        "parentContractId": "stage1-2026-09-09-pilot-r32-s20260909",
        "adapterConfigSha256": "edf24b93506b19ea31631fe10020918185b5efca36800084879694e651deb352",
        "adapterWeightsSha256": "36fd8741c18e1a1478629473c7701584e8e9bc92f890eeedf3effff5d3638528",
        "adapterWeightsBytes": 933974032,
        "rank": 32,
    }

    def _parent_contract(self, **init_overrides):
        parent = dict(self.PARENT)
        parent.update(init_overrides.pop("parent", {}))
        initialization = {"mode": "parent", "optimizer": "reset", "parent": parent}
        initialization.update(init_overrides)
        contract = {
            "schema": "amos.qwen-adapter-training-contract",
            "version": init_overrides.pop("version", 2),
            "id": "stage1-parent-under-test",
            "purpose": "amos-system-competence-sft",
            "qualityClaimAllowed": False,
            "promotionAllowed": False,
            "recipe": {
                "stage": 1,
                "adapter": {"rank": 32},
                "initialization": initialization,
                "optimization": {"loss": "assistant-tokens-only"},
                "includeVisionTowerInAdapter": False,
            },
            "selection": {"trainerMayNotSelect": True},
            "execution": {"liveInferenceEndpointMutable": False, "torchNativeJitDisabled": True},
            "exitCriteria": {k: True for k in TRAINER.PARENT_PROOF_EXIT_CRITERIA},
        }
        contract["digest"] = TRAINER.digest_value({k: v for k, v in contract.items() if k != "digest"})
        return contract

    def test_validate_accepts_a_well_formed_parent_v2_contract(self):
        self.assertEqual(TRAINER.validate_contract(self._parent_contract())["mode"], "parent")

    def test_parent_mode_must_be_version_2(self):
        c = self._parent_contract()
        c["version"] = 1
        c["digest"] = TRAINER.digest_value({k: v for k, v in c.items() if k != "digest"})
        with self.assertRaises(ValueError):
            TRAINER.validate_contract(c)

    def test_parent_contract_missing_a_proof_criterion_is_rejected(self):
        c = self._parent_contract()
        del c["exitCriteria"]["childAdapterMustDifferFromParentProbe"]
        c["digest"] = TRAINER.digest_value({k: v for k, v in c.items() if k != "digest"})
        with self.assertRaises(ValueError):
            TRAINER.validate_contract(c)

    def test_normalize_defaults_missing_flags_to_true_and_never_false(self):
        c = self._parent_contract()  # fixture omits loadTrainable/stackingForbidden
        self.assertNotIn("loadTrainable", c["recipe"]["initialization"]["parent"])
        result = TRAINER.normalize_initialization(c)
        self.assertIs(result["parent"]["loadTrainable"], True)
        self.assertIs(result["parent"]["stackingForbidden"], True)

    def test_normalize_rejects_explicit_false_flags(self):
        c = self._parent_contract(parent={"loadTrainable": False})
        with self.assertRaises(ValueError):
            TRAINER.normalize_initialization(c)

    def test_normalize_rejects_unknown_mode_and_does_not_fall_back_to_fresh(self):
        c = self._parent_contract()
        c["recipe"]["initialization"]["mode"] = "warmstart"
        with self.assertRaises(ValueError):
            TRAINER.normalize_initialization(c)

    def test_normalize_requires_explicit_optimizer_reset(self):
        c = self._parent_contract()
        del c["recipe"]["initialization"]["optimizer"]
        with self.assertRaises(ValueError):
            TRAINER.normalize_initialization(c)

    def test_normalize_trims_mode_and_optimizer(self):
        c = self._parent_contract()
        c["recipe"]["initialization"]["mode"] = " parent "
        c["recipe"]["initialization"]["optimizer"] = " reset "
        self.assertEqual(TRAINER.normalize_initialization(c)["mode"], "parent")

    def test_normalize_rejects_parent_rank_that_disagrees_with_adapter_rank(self):
        c = self._parent_contract(parent={"rank": 16})
        with self.assertRaises(ValueError):
            TRAINER.normalize_initialization(c)

    def test_absent_initialization_is_historical_fresh(self):
        self.assertEqual(TRAINER.normalize_initialization({"recipe": {}})["mode"], "fresh")

    def test_parent_adapter_download_verifies_file_hashes(self):
        import hashlib as _h
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            weights_body = b"parent-weights"
            config_body = b'{"peft_type":"LORA"}'
            def fake_download(uri, dest):
                dest.write_bytes(weights_body if dest.name.endswith(".safetensors") else config_body)
            original = TRAINER.download_uri
            TRAINER.download_uri = fake_download
            try:
                parent = dict(self.PARENT)
                parent["adapterWeightsSha256"] = _h.sha256(weights_body).hexdigest()
                parent["adapterConfigSha256"] = _h.sha256(config_body).hexdigest()
                parent["adapterWeightsBytes"] = len(weights_body)
                out = TRAINER.download_and_verify_parent_adapter(parent, root / "p")
                self.assertTrue((out / "adapter_model.safetensors").is_file())
                parent["adapterWeightsSha256"] = "0" * 64
                with self.assertRaises(ValueError):
                    TRAINER.download_and_verify_parent_adapter(parent, root / "q")
            finally:
                TRAINER.download_uri = original



class ParentAdapterConfigBindingTests(unittest.TestCase):
    RECIPE = {"type": "lora", "rank": 32, "alpha": 64, "dropout": 0.05, "bias": "none",
              "targetModules": ["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj",
                                "down_proj", "in_proj_qkv", "in_proj_z", "in_proj_b", "in_proj_a", "out_proj"]}

    def _config(self, **overrides):
        cfg = {"peft_type": "LORA", "task_type": "CAUSAL_LM", "r": 32, "lora_alpha": 64,
               "lora_dropout": 0.05, "bias": "none", "inference_mode": True,
               "target_modules": list(self.RECIPE["targetModules"])}
        cfg.update(overrides)
        return cfg

    def test_archived_matching_config_is_accepted_including_inference_mode_true(self):
        # is_trainable=True overrides the saved inference_mode; it must NOT be rejected.
        TRAINER.verify_parent_adapter_config(self._config(inference_mode=True), self.RECIPE)

    def test_effective_config_drift_is_rejected(self):
        for override in [{"r": 16}, {"lora_alpha": 128}, {"lora_dropout": 0.9},
                         {"bias": "all"}, {"target_modules": ["q_proj"]},
                         {"rank_pattern": {"q_proj": 16}}, {"alpha_pattern": {"q_proj": 128}},
                         {"use_rslora": True}, {"use_dora": True},
                         {"modules_to_save": ["embed_tokens"]}, {"layers_to_transform": [0, 1]},
                         {"peft_type": "IA3"}, {"task_type": "SEQ_CLS"},
                         {"exclude_modules": ["lm_head"]}, {"target_parameters": ["foo"]},
                         {"layer_replication": [[0, 2]]}, {"fan_in_fan_out": True},
                         {"lora_bias": True}, {"use_dora": "yes"}, {"use_rslora": 1}]:
            with self.subTest(override=override):
                with self.assertRaises(ValueError):
                    TRAINER.verify_parent_adapter_config(self._config(**override), self.RECIPE)

    def test_explicit_false_flags_are_accepted(self):
        TRAINER.verify_parent_adapter_config(
            self._config(use_rslora=False, use_dora=False, fan_in_fan_out=False, lora_bias=False),
            self.RECIPE,
        )


class ParentPendingProofStatusTests(unittest.TestCase):
    def test_parent_status_and_remaining_criteria_differ_from_fresh(self):
        self.assertEqual(TRAINER.stage_one_result_status("fresh"), "adapter-built-awaiting-vllm-load-proof")
        parent_status = TRAINER.stage_one_result_status("parent")
        self.assertNotEqual(parent_status, "adapter-built-awaiting-vllm-load-proof")
        remaining = TRAINER.stage_one_remaining_exit_criteria("parent")
        for criterion in TRAINER.PARENT_PROOF_EXIT_CRITERIA:
            self.assertIn(criterion, remaining)
        self.assertIn("vllm-adapter-load-proof", remaining)

    def test_legacy_vllm_verifier_fails_closed_on_a_parent_report(self):
        import importlib.util as _u
        verifier_path = MODULE_PATH.parent.parent / "adapter-verifier" / "verify_vllm_adapter.py"
        spec = _u.spec_from_file_location("pr98_legacy_verifier", verifier_path)
        verifier = _u.module_from_spec(spec)
        spec.loader.exec_module(verifier)
        with tempfile.TemporaryDirectory() as tmp:
            adapter = Path(tmp)
            (adapter / "adapter_model.safetensors").write_bytes(b"synthetic")
            (adapter / "adapter_config.json").write_bytes(b"{}")
            report = {"schema": "amos.qwen-adapter-stage0-result",
                      "status": TRAINER.stage_one_result_status("parent"),
                      "promotionAllowed": False, "qualityClaimAllowed": False,
                      "parameters": {"initializationMode": "parent"},
                      "remainingExitCriteria": TRAINER.stage_one_remaining_exit_criteria("parent")}
            with self.assertRaises((RuntimeError, ValueError, KeyError)):
                verifier._validate_lineage(report, adapter)


class ParentTensorDigestTests(unittest.TestCase):
    def _items(self):
        return [("base_model.model.q_proj.lora_A.default.weight", "bfloat16", (32, 4096), b"\x01\x02"),
                ("base_model.model.q_proj.lora_B.default.weight", "bfloat16", (4096, 32), b"\x03\x04")]

    def test_name_normalization_removes_default_adapter_segment(self):
        self.assertEqual(TRAINER.normalize_lora_tensor_name("x.lora_A.default.weight"), "x.lora_A.weight")

    def test_digest_is_order_independent(self):
        items = self._items()
        self.assertEqual(TRAINER.adapter_tensor_digest(items), TRAINER.adapter_tensor_digest(list(reversed(items))))

    def test_loaded_and_saved_names_agree_after_normalization(self):
        loaded = self._items()
        saved = [("base_model.model.q_proj.lora_A.weight", "bfloat16", (32, 4096), b"\x01\x02"),
                 ("base_model.model.q_proj.lora_B.weight", "bfloat16", (4096, 32), b"\x03\x04")]
        self.assertEqual(TRAINER.adapter_tensor_digest(loaded), TRAINER.adapter_tensor_digest(saved))

    def test_changed_value_shape_dtype_or_name_changes_digest(self):
        base = TRAINER.adapter_tensor_digest(self._items())
        for mutate in [
            lambda it: [(it[0][0], it[0][1], it[0][2], b"\x09\x09"), it[1]],
            lambda it: [(it[0][0], it[0][1], (16, 4096), it[0][3]), it[1]],
            lambda it: [(it[0][0], "float16", it[0][2], it[0][3]), it[1]],
            lambda it: [("base_model.model.k_proj.lora_A.default.weight", it[0][1], it[0][2], it[0][3]), it[1]],
        ]:
            self.assertNotEqual(base, TRAINER.adapter_tensor_digest(mutate(self._items())))

    def test_missing_or_extra_tensor_changes_digest(self):
        base = TRAINER.adapter_tensor_digest(self._items())
        self.assertNotEqual(base, TRAINER.adapter_tensor_digest(self._items()[:1]))
        extra = self._items() + [("base_model.model.v_proj.lora_A.default.weight", "bfloat16", (32, 4096), b"\x07")]
        self.assertNotEqual(base, TRAINER.adapter_tensor_digest(extra))

    def test_duplicate_normalized_name_is_rejected(self):
        dup = self._items() + [("base_model.model.q_proj.lora_A.default.weight", "bfloat16", (32, 4096), b"\xff")]
        with self.assertRaises(ValueError):
            TRAINER.adapter_tensor_digest(dup)


class ParentUpdateReceiptTests(unittest.TestCase):
    def _receipt(self, **overrides):
        h = lambda seed: __import__("hashlib").sha256(seed).hexdigest()
        loaded = h(b"parent-tensor-state")
        receipt = {
            "protocolVersion": TRAINER.PARENT_TENSOR_DIGEST_PROTOCOL,
            "parentWeightSha256": "36fd8741c18e1a1478629473c7701584e8e9bc92f890eeedf3effff5d3638528",
            "parentConfigSha256": "edf24b93506b19ea31631fe10020918185b5efca36800084879694e651deb352",
            "trainingContractSha256": h(b"child-contract"),
            "childWeightSha256": h(b"child-weights"),
            "expectedParentTensorSha256": loaded,
            "loadedInitialTensorSha256": loaded,
            "finalTensorSha256": h(b"child-tensor-state"),
            "optimizerUpdates": 42,
            "optimizer": "reset",
            "baseUnchanged": True,
            "savedReloadExact": True,
        }
        receipt.update(overrides)
        return receipt

    def test_a_valid_receipt_passes(self):
        TRAINER.assert_parent_update_receipt(self._receipt())

    def test_misloaded_parent_is_rejected(self):
        with self.assertRaises(ValueError):
            TRAINER.assert_parent_update_receipt(self._receipt(loadedInitialTensorSha256=__import__("hashlib").sha256(b"wrong").hexdigest()))

    def test_copied_parent_zero_movement_is_rejected(self):
        r = self._receipt()
        with self.assertRaises(ValueError):
            TRAINER.assert_parent_update_receipt(self._receipt(finalTensorSha256=r["loadedInitialTensorSha256"]))

    def test_zero_or_nonpositive_updates_rejected(self):
        for bad in (0, -1, True, "5"):
            with self.assertRaises(ValueError):
                TRAINER.assert_parent_update_receipt(self._receipt(optimizerUpdates=bad))

    def test_non_reset_optimizer_rejected(self):
        with self.assertRaises(ValueError):
            TRAINER.assert_parent_update_receipt(self._receipt(optimizer="resume"))

    def test_base_or_reload_evidence_must_hold(self):
        with self.assertRaises(ValueError):
            TRAINER.assert_parent_update_receipt(self._receipt(baseUnchanged=False))
        with self.assertRaises(ValueError):
            TRAINER.assert_parent_update_receipt(self._receipt(savedReloadExact=False))

    def test_child_file_identical_to_parent_rejected(self):
        r = self._receipt()
        with self.assertRaises(ValueError):
            TRAINER.assert_parent_update_receipt(self._receipt(childWeightSha256=r["parentWeightSha256"]))

    def test_missing_protocol_version_rejected(self):
        r = self._receipt(); del r["protocolVersion"]
        with self.assertRaises(ValueError):
            TRAINER.assert_parent_update_receipt(r)

if __name__ == "__main__":
    unittest.main()
