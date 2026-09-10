import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

import verify_vllm_adapter as verifier


class VerifyVllmAdapterTests(unittest.TestCase):
    def _fixture(self, root: Path):
        adapter = root / "adapter"
        adapter.mkdir()
        model_bytes = b"bounded-adapter-fixture"
        (adapter / "adapter_model.safetensors").write_bytes(model_bytes)
        (adapter / "adapter_config.json").write_text('{"r": 16}\n', encoding="utf-8")
        files = []
        for name in ("adapter_model.safetensors", "adapter_config.json"):
            value = (adapter / name).read_bytes()
            files.append({"path": name, "sha256": hashlib.sha256(value).hexdigest()})
        stage0 = {
            "schema": "amos.qwen-adapter-stage0-result",
            "status": "adapter-built-awaiting-vllm-load-proof",
            "promotionAllowed": False,
            "qualityClaimAllowed": False,
            "adapterFiles": files,
        }
        return adapter, stage0

    def test_validate_lineage_accepts_exact_non_promoting_adapter(self):
        with tempfile.TemporaryDirectory() as temporary:
            adapter, stage0 = self._fixture(Path(temporary))
            config, rank = verifier._validate_lineage(stage0, adapter)
            self.assertEqual(rank, 16)
            self.assertEqual(config, {"r": 16})

    def test_validate_lineage_rejects_adapter_digest_mismatch(self):
        with tempfile.TemporaryDirectory() as temporary:
            adapter, stage0 = self._fixture(Path(temporary))
            (adapter / "adapter_model.safetensors").write_bytes(b"changed")
            with self.assertRaisesRegex(ValueError, "digest mismatch"):
                verifier._validate_lineage(stage0, adapter)

    def test_receipt_digest_excludes_the_digest_field(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "receipt.json"
            receipt = {"schema": verifier.SCHEMA, "version": verifier.VERSION, "status": "failed"}
            verifier._write_receipt(path, receipt)
            saved = json.loads(path.read_text(encoding="utf-8"))
            digest = saved.pop("digest")
            canonical = json.dumps(saved, sort_keys=True, separators=(",", ":")).encode("utf-8")
            self.assertEqual(digest, hashlib.sha256(canonical).hexdigest())

    def test_vllm_027_command_uses_current_boolean_logging_flag(self):
        command = verifier._server_command(
            base_model_path=Path("/model"),
            adapter_path=Path("/adapter"),
            base_name="base",
            adapter_name="adapter",
            rank=16,
        )
        self.assertIn("--no-enable-log-requests", command)
        self.assertNotIn("--disable-log-requests", command)

    def test_runtime_caches_stay_on_ephemeral_writable_storage(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            environment = verifier._server_environment(root)
            for name in ("HOME", "TRITON_CACHE_DIR", "XDG_CACHE_HOME", "HF_HOME"):
                location = Path(environment[name])
                self.assertTrue(location.is_dir())
                self.assertTrue(location.is_relative_to(root))
            self.assertEqual(environment["VLLM_USE_FLASHINFER_SAMPLER"], "0")



class ParentAwareLineageTests(unittest.TestCase):
    """In-repo positive control + key negatives for the parent continuation transition. Codex's
    external check_transition.py covers the full 27-case matrix; these guard CI against regressions."""
    import importlib.util as _ilu
    _base = Path(__file__).resolve().parent.parent / "trainer"
    _tspec = _ilu.spec_from_file_location("verifier_trainer", _base / "train_stage0.py")
    TR = _ilu.module_from_spec(_tspec); _tspec.loader.exec_module(TR)
    _sspec = _ilu.spec_from_file_location("verifier_trainer_tests", _base / "test_train_stage0.py")
    SRC = _ilu.module_from_spec(_sspec); _sspec.loader.exec_module(SRC)

    def _safetensors(self, path, value):
        import struct
        entries, body, items = {}, bytearray(), []
        for name, shape in [("base_model.model.q_proj.lora_A.weight", (32, 1)),
                            ("base_model.model.q_proj.lora_B.weight", (1, 32))]:
            raw = struct.pack("<32f", *([value] * 32))
            entries[name] = {"dtype": "F32", "shape": list(shape), "data_offsets": [len(body), len(body) + len(raw)]}
            body.extend(raw); items.append((name, "torch.float32", shape, raw))
        header = json.dumps(entries, separators=(",", ":")).encode()
        header += b" " * ((-len(header)) % 8)
        path.write_bytes(struct.pack("<Q", len(header)) + header + body)
        return items

    def _sign(self, value):
        value.pop("digest", None)
        value["digest"] = self.TR.digest_value(value)
        return value

    def _case(self, directory):
        sha = lambda b: hashlib.sha256(b).hexdigest()
        adapter = directory / "adapter"; parent = directory / "parent"
        adapter.mkdir(); parent.mkdir()
        config = {"peft_type": "LORA", "task_type": "CAUSAL_LM", "r": 32, "lora_alpha": 64,
                  "lora_dropout": .05, "bias": "none", "target_modules": ["q_proj"], "inference_mode": True}
        for folder in (parent, adapter):
            (folder / "adapter_config.json").write_text(json.dumps(config))
        parent_items = self._safetensors(parent / "adapter_model.safetensors", 1.0)
        child_items = self._safetensors(adapter / "adapter_model.safetensors", 2.0)
        contract = self.SRC.ParentInitializationTests()._parent_contract()
        contract["id"] = "cpu-verifier-inrepo"
        contract["recipe"]["adapter"] = {"type": "lora", "rank": 32, "alpha": 64, "dropout": .05,
                                         "bias": "none", "targetModules": ["q_proj"]}
        p = contract["recipe"]["initialization"]["parent"]
        p.update(adapterUri="s3://cpu/parent", parentContractId="cpu-parent",
                 adapterConfigSha256=sha((parent / "adapter_config.json").read_bytes()),
                 adapterWeightsSha256=sha((parent / "adapter_model.safetensors").read_bytes()),
                 adapterWeightsBytes=(parent / "adapter_model.safetensors").stat().st_size)
        self._sign(contract)
        initial = self.TR.adapter_tensor_digest(parent_items)
        final = self.TR.adapter_tensor_digest(child_items)
        receipt = {"protocolVersion": self.TR.PARENT_TENSOR_DIGEST_PROTOCOL,
                   "parentWeightSha256": p["adapterWeightsSha256"], "parentConfigSha256": p["adapterConfigSha256"],
                   "trainingContractSha256": contract["digest"], "childWeightSha256": sha((adapter / "adapter_model.safetensors").read_bytes()),
                   "expectedParentTensorSha256": initial, "loadedInitialTensorSha256": initial,
                   "finalTensorSha256": final, "reloadedTensorSha256": final, "optimizerUpdates": 2,
                   "optimizer": "reset", "baseUnchanged": True, "savedReloadExact": True,
                   "baseEvidenceScope": "frozen-adapter-scope-and-fixed-logit-probe"}
        report = {"schema": "amos.qwen-adapter-stage0-result", "version": 1, "stage": 1,
                  "purpose": "amos-system-competence-sft", "status": self.TR.stage_one_result_status("parent"),
                  "contractId": contract["id"], "contractDigest": contract["digest"],
                  "promotionAllowed": False, "qualityClaimAllowed": False,
                  "parameters": {"initializationMode": "parent"}, "parentInitializationReceipt": receipt,
                  "remainingExitCriteria": self.TR.stage_one_remaining_exit_criteria("parent"),
                  "adapterFiles": [{"path": q.name, "sha256": sha(q.read_bytes()), "bytes": q.stat().st_size}
                                   for q in sorted(adapter.iterdir())]}
        self._sign(report)
        return adapter, report, contract

    def test_valid_parent_report_is_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            adapter, report, contract = self._case(Path(d))
            config, rank = verifier._validate_lineage(report, adapter, contract)
            self.assertEqual(rank, 32)

    def test_key_parent_negatives_reject(self):
        mutations = [
            ("status_downgraded_to_fresh", lambda r, c: r.update(status="adapter-built-awaiting-vllm-load-proof")),
            ("receipt_missing", lambda r, c: r.pop("parentInitializationReceipt")),
            ("misloaded_parent", lambda r, c: r["parentInitializationReceipt"].update(loadedInitialTensorSha256="6" * 64)),
            ("copied_state", lambda r, c: r["parentInitializationReceipt"].update(finalTensorSha256=r["parentInitializationReceipt"]["loadedInitialTensorSha256"], reloadedTensorSha256=r["parentInitializationReceipt"]["loadedInitialTensorSha256"])),
            ("parent_weight_not_contract", lambda r, c: r["parentInitializationReceipt"].update(parentWeightSha256="1" * 64)),
            ("report_wrong_contract_id", lambda r, c: r.update(contractId="another")),
            ("manifest_traversal", lambda r, c: r["adapterFiles"].append({"path": "../escape.txt", "sha256": "0" * 64, "bytes": 1})),
        ]
        for name, mutate in mutations:
            with self.subTest(case=name), tempfile.TemporaryDirectory() as d:
                adapter, report, contract = self._case(Path(d))
                mutate(report, contract)
                self._sign(report)
                with self.assertRaises((ValueError, RuntimeError)):
                    verifier._validate_lineage(report, adapter, contract)
    def test_packaged_layout_import_resolves_trainer(self):
        # Simulate the image COPY layout: verifier + trainer co-located in one application dir.
        import importlib.util, shutil
        base = Path(__file__).resolve().parent
        with tempfile.TemporaryDirectory() as d:
            app = Path(d)
            shutil.copyfile(base / "verify_vllm_adapter.py", app / "verify_vllm_adapter.py")
            shutil.copyfile(base.parent / "trainer" / "train_stage0.py", app / "train_stage0.py")
            spec = importlib.util.spec_from_file_location("packaged_verifier", app / "verify_vllm_adapter.py")
            module = importlib.util.module_from_spec(spec)
            sys.modules["packaged_verifier"] = module
            spec.loader.exec_module(module)
            self.assertTrue(hasattr(module._trainer(), "assert_parent_update_receipt"))



if __name__ == "__main__":
    unittest.main()
