#!/usr/bin/env python3
"""Produce an isolated, non-promoting vLLM LoRA load proof."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


SCHEMA = "amos.qwen-vllm-adapter-load-proof"
VERSION = 1


def _required_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise ValueError(f"{name} is required")
    return value


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return value


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_receipt(path: Path, receipt: dict[str, Any]) -> None:
    unsigned = dict(receipt)
    unsigned.pop("digest", None)
    canonical = json.dumps(unsigned, sort_keys=True, separators=(",", ":")).encode("utf-8")
    receipt["digest"] = _sha256_bytes(canonical)
    path.write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _server_command(
    *,
    base_model_path: Path,
    adapter_path: Path,
    base_name: str,
    adapter_name: str,
    rank: int,
) -> list[str]:
    return [
        sys.executable,
        "-m",
        "vllm.entrypoints.openai.api_server",
        "--model",
        str(base_model_path),
        "--served-model-name",
        base_name,
        "--enable-lora",
        "--lora-modules",
        f"{adapter_name}={adapter_path}",
        "--max-lora-rank",
        str(rank),
        "--max-model-len",
        "2048",
        "--gpu-memory-utilization",
        "0.9",
        "--enforce-eager",
        "--no-enable-log-requests",
    ]


def _server_environment(cache_root: Path = Path("/tmp/amos-vllm-cache")) -> dict[str, str]:
    locations = {
        "HOME": cache_root / "home",
        "TRITON_CACHE_DIR": cache_root / "triton",
        "XDG_CACHE_HOME": cache_root / "xdg",
        "HF_HOME": cache_root / "huggingface",
    }
    for location in locations.values():
        location.mkdir(parents=True, exist_ok=True)
    return {
        **os.environ,
        **{name: str(location) for name, location in locations.items()},
        # The verifier image intentionally contains the CUDA runtime rather than
        # the full compiler toolchain.  vLLM otherwise auto-selects FlashInfer's
        # JIT sampler, which requires nvcc during engine startup.  The native
        # sampler exercises the same model and adapter without broadening the
        # verifier image or changing candidate behavior.
        "VLLM_USE_FLASHINFER_SAMPLER": "0",
    }


def _request_json(url: str, payload: dict[str, Any] | None = None, timeout: float = 30) -> tuple[dict[str, Any], float]:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(url, data=body, headers={"Content-Type": "application/json"})
    started = time.monotonic()
    with urlopen(request, timeout=timeout) as response:  # noqa: S310 - loopback-only verifier
        raw = response.read()
    elapsed = time.monotonic() - started
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError(f"{url} did not return a JSON object")
    return value, elapsed


def _wait_until_ready(base_url: str, process: subprocess.Popen[bytes], deadline_seconds: int) -> float:
    started = time.monotonic()
    deadline = started + deadline_seconds
    last_error = "not started"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"vLLM exited before readiness with status {process.returncode}")
        try:
            _request_json(f"{base_url}/v1/models", timeout=5)
            return time.monotonic() - started
        except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, ValueError) as error:
            last_error = f"{type(error).__name__}: {error}"
            time.sleep(2)
    raise TimeoutError(f"vLLM did not become ready within {deadline_seconds}s; last error: {last_error}")


FRESH_LINEAGE_STATUS = "adapter-built-awaiting-vllm-load-proof"

_TRAINER_MODULE: Any = None


def _trainer() -> Any:
    """Load the trainer module (functions only; torch imports are lazy) to reuse the exact
    receipt/digest validators the producer emitted, keeping producer and verifier in lockstep."""
    global _TRAINER_MODULE
    if _TRAINER_MODULE is None:
        import importlib.util

        here = Path(__file__).resolve().parent
        # Repo layout: sibling trainer/ dir. Packaged layout: co-located in the application dir.
        candidates = [here / "train_stage0.py", here.parent / "trainer" / "train_stage0.py"]
        path = next((candidate for candidate in candidates if candidate.is_file()), None)
        if path is None:
            raise RuntimeError("trainer module train_stage0.py is not available beside the verifier")
        spec = importlib.util.spec_from_file_location("amos_trainer_for_verifier", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _TRAINER_MODULE = module
    return _TRAINER_MODULE


def _verify_report_digest(stage0: dict[str, Any]) -> None:
    claimed = stage0.get("digest")
    body = {key: value for key, value in stage0.items() if key != "digest"}
    if not isinstance(claimed, str) or _trainer().digest_value(body) != claimed:
        raise ValueError("stage-zero result digest does not match its contents")


def _validated_adapter_manifest(stage0: dict[str, Any]) -> dict[str, str]:
    """Return path->sha256, rejecting an empty, malformed, escaping, or conflicting manifest."""
    files = stage0.get("adapterFiles")
    if not isinstance(files, list) or not files:
        raise ValueError("adapter manifest is empty or malformed")
    manifest: dict[str, str] = {}
    for item in files:
        if not isinstance(item, dict):
            raise ValueError("adapter manifest entry is malformed")
        path = item.get("path")
        sha = item.get("sha256")
        if not isinstance(path, str) or not isinstance(sha, str):
            raise ValueError("adapter manifest entry is malformed")
        if os.path.isabs(path) or path.startswith("..") or os.path.normpath(path) != path:
            raise ValueError(f"adapter manifest path escapes the adapter directory: {path}")
        if path in manifest and manifest[path] != sha:
            raise ValueError(f"conflicting duplicate adapter manifest entry: {path}")
        manifest[path] = sha
    for required in ("adapter_model.safetensors", "adapter_config.json"):
        if required not in manifest:
            raise ValueError(f"adapter manifest is missing {required}")
    return manifest


def _resolve_child_contract(adapter_path: Path, contract: dict[str, Any] | None) -> dict[str, Any] | None:
    if contract is not None:
        return contract
    candidate = adapter_path.parent / "training-contract.json"
    return _read_json(candidate) if candidate.is_file() else None


def _lineage_mode(stage0: dict[str, Any], contract: dict[str, Any] | None) -> str:
    """Classify the lineage from the FULLY VALIDATED child contract and the report, and reject an
    inconsistent pair. A present parent contract may never be routed through the fresh path, and a
    parent report is never trusted without a validated parent contract to bind it to."""
    trainer = _trainer()
    contract_mode = None
    if contract is not None:
        trainer.validate_contract(contract)  # real full validator: stale/forbidden contracts reject
        contract_mode = trainer.normalize_initialization(contract)["mode"]
    report_is_parent = (
        (stage0.get("parameters") or {}).get("initializationMode") == "parent"
        or stage0.get("parentInitializationReceipt") is not None
    )
    if contract_mode == "parent" or report_is_parent:
        if contract_mode != "parent":
            raise ValueError("parent report is not backed by a validated parent child contract")
        if not report_is_parent:
            raise ValueError("parent child contract requires a parent continuation report")
        return "parent"
    return "fresh"


def _validate_parent_lineage(stage0: dict[str, Any], manifest: dict[str, str], contract: dict[str, Any]) -> None:
    """Validate the bound observed parent-update proof before any outstanding criterion is removed.
    The contract has already been fully validated and confirmed to be a parent contract."""
    trainer = _trainer()
    _verify_report_digest(stage0)
    if stage0.get("status") != trainer.stage_one_result_status("parent"):
        raise ValueError("parent continuation result must await observed parent proof")
    receipt = stage0.get("parentInitializationReceipt")
    if not isinstance(receipt, dict):
        raise ValueError("parent continuation result must carry the parent-update receipt")
    trainer.assert_parent_update_receipt(receipt)
    if receipt["childWeightSha256"] != manifest.get("adapter_model.safetensors"):
        raise ValueError("receipt child weight hash is not the saved adapter artifact")
    parent = (contract.get("recipe", {}).get("initialization", {}) or {}).get("parent") or {}
    if receipt["parentWeightSha256"] != parent.get("adapterWeightsSha256"):
        raise ValueError("receipt parent weight hash does not match the contract parent")
    if receipt["parentConfigSha256"] != parent.get("adapterConfigSha256"):
        raise ValueError("receipt parent config hash does not match the contract parent")
    if receipt["trainingContractSha256"] != contract.get("digest"):
        raise ValueError("receipt training contract hash is not this child contract")
    if stage0.get("contractDigest") != contract.get("digest"):
        raise ValueError("report contract digest is not this child contract")
    if stage0.get("contractId") != contract.get("id"):
        raise ValueError("report contract id is not this child contract")


def _validate_lineage(stage0: dict[str, Any], adapter_path: Path,
                      contract: dict[str, Any] | None = None) -> tuple[dict[str, Any], int]:
    if stage0.get("schema") != "amos.qwen-adapter-stage0-result":
        raise ValueError("stage-zero result schema is invalid")
    if stage0.get("promotionAllowed") is not False or stage0.get("qualityClaimAllowed") is not False:
        raise ValueError("stage-zero result must remain non-promoting")
    manifest = _validated_adapter_manifest(stage0)
    contract = _resolve_child_contract(adapter_path, contract)
    if _lineage_mode(stage0, contract) == "parent":
        _validate_parent_lineage(stage0, manifest, contract)
    elif stage0.get("status") != FRESH_LINEAGE_STATUS:
        raise ValueError("stage-zero result is not awaiting the vLLM proof")

    for relative, expected_digest in manifest.items():
        actual_path = adapter_path / relative
        if not actual_path.is_file():
            raise ValueError(f"adapter file is missing: {relative}")
        if _sha256_file(actual_path) != expected_digest:
            raise ValueError(f"adapter file digest mismatch: {relative}")

    config = _read_json(adapter_path / "adapter_config.json")
    rank = config.get("r")
    if not isinstance(rank, int) or rank <= 0:
        raise ValueError("adapter_config.json must contain a positive integer rank")
    return config, rank


def _discharged_exit_criteria(stage0: dict[str, Any]) -> list[str]:
    """On a successful vLLM load proof, discharge ONLY the criteria this verifier actually proved:
    the vLLM adapter-load proof plus, for a validated parent continuation, the parent proofs. Any
    other outstanding criterion is preserved rather than silently erased."""
    proven = {"vllm-adapter-load-proof"}
    if stage0.get("parentInitializationReceipt") is not None:
        proven |= set(_trainer().PARENT_PROOF_EXIT_CRITERIA)
    original = stage0.get("remainingExitCriteria")
    if not isinstance(original, list):
        return []
    return [criterion for criterion in original if criterion not in proven]


def _completion_probe(base_url: str, model: str) -> dict[str, Any]:
    response, latency = _request_json(
        f"{base_url}/v1/chat/completions",
        {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": "Return exactly one short sentence confirming that this isolated adapter runtime can answer.",
                }
            ],
            "max_tokens": 32,
            "temperature": 0,
        },
        timeout=180,
    )
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise ValueError(f"model {model} returned no choices")
    return {
        "latencySeconds": round(latency, 6),
        "model": response.get("model"),
        "responseDigest": _sha256_bytes(json.dumps(response, sort_keys=True).encode("utf-8")),
        "usage": response.get("usage"),
    }


def main() -> int:
    base_model_path = Path(_required_env("AMOS_BASE_MODEL_PATH"))
    adapter_path = Path(_required_env("AMOS_ADAPTER_PATH"))
    stage0_result_path = Path(_required_env("AMOS_STAGE0_RESULT_PATH"))
    result_path = Path(os.environ.get("AMOS_VLLM_PROOF_PATH", "/work/vllm-adapter-load-proof.json"))
    image_digest = _required_env("AMOS_VERIFIER_IMAGE_DIGEST")
    if not image_digest.startswith("sha256:") or len(image_digest) != 71:
        raise ValueError("AMOS_VERIFIER_IMAGE_DIGEST must be a sha256 OCI digest")
    if not base_model_path.is_dir():
        raise ValueError("AMOS_BASE_MODEL_PATH must be a mounted directory")
    if not adapter_path.is_dir():
        raise ValueError("AMOS_ADAPTER_PATH must be a mounted directory")

    stage0 = _read_json(stage0_result_path)
    _adapter_config, rank = _validate_lineage(stage0, adapter_path)
    base_name = "amos-qwen38-27b-fp8"
    adapter_name = "amos-qwen38-stage0-r3"
    base_url = "http://127.0.0.1:8000"
    log_path = result_path.with_suffix(".vllm.log")
    command = _server_command(
        base_model_path=base_model_path,
        adapter_path=adapter_path,
        base_name=base_name,
        adapter_name=adapter_name,
        rank=rank,
    )
    process: subprocess.Popen[bytes] | None = None
    receipt: dict[str, Any] = {
        "schema": SCHEMA,
        "version": VERSION,
        "status": "failed",
        "contractId": stage0.get("contractId"),
        "contractDigest": stage0.get("contractDigest"),
        "stage0ResultDigest": stage0.get("digest"),
        "adapterModelDigest": next(
            (item.get("sha256") for item in stage0.get("adapterFiles", []) if item.get("path") == "adapter_model.safetensors"),
            None,
        ),
        "verifierImageDigest": image_digest,
        "qualityClaimAllowed": False,
        "promotionAllowed": False,
    }
    try:
        result_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("wb") as log_handle:
            process = subprocess.Popen(
                command,
                stdout=log_handle,
                stderr=subprocess.STDOUT,
                env=_server_environment(),
            )
            ready_seconds = _wait_until_ready(base_url, process, deadline_seconds=1200)
            models, _ = _request_json(f"{base_url}/v1/models", timeout=30)
            model_ids = sorted(
                item.get("id")
                for item in models.get("data", [])
                if isinstance(item, dict) and isinstance(item.get("id"), str)
            )
            if base_name not in model_ids or adapter_name not in model_ids:
                raise ValueError(f"expected base and adapter model IDs; received {model_ids}")
            receipt.update(
                {
                    "status": "adapter-load-proven",
                    "vllmVersion": __import__("vllm").__version__,
                    "torchVersion": __import__("torch").__version__,
                    "readySeconds": round(ready_seconds, 6),
                    "modelIds": model_ids,
                    "baseProbe": _completion_probe(base_url, base_name),
                    "adapterProbe": _completion_probe(base_url, adapter_name),
                    "remainingExitCriteria": _discharged_exit_criteria(stage0),
                }
            )
    except Exception as error:  # receipt must survive every bounded verifier failure
        receipt["error"] = {"type": type(error).__name__, "message": str(error)}
        return_code = 1
    else:
        return_code = 0
    finally:
        if process is not None and process.poll() is None:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
        receipt["serverExitStatus"] = None if process is None else process.returncode
        _write_receipt(result_path, receipt)
    return return_code


if __name__ == "__main__":
    raise SystemExit(main())
