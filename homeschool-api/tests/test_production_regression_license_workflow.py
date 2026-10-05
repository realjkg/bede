"""
production-regression.yml must mint its own throwaway license per job.

The failure this closes was external staleness dressed up as a code failure:
`CI_TEST_LICENSE_KEY` had to be reissued by hand against an offline private
key, and once it drifted out of sync with core/licensing.py's embedded public
key the production-regression job went red on unrelated changes. The workflow
now generates an ephemeral Ed25519 keypair and short-lived trial license inside
each job, then rewrites the checked-out `core/licensing.py` before any build or
compose step runs.

This test guards both the function and its invocation:

* the long-lived GitHub secret must stay gone, or the original staleness path
  comes back;
* every job that needs a license must mint one before its first consumer, or
  one fresh job will still be reading a stale/empty value.
"""
import re
from pathlib import Path


_WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "production-regression.yml"


def _job_block(name: str) -> str:
    text = _WORKFLOW.read_text()
    block = text.split(f"\n  {name}:\n", 1)[1]
    return re.split(r"\n  [a-z0-9-]+:\n", block, maxsplit=1)[0]


def test_production_regression_no_longer_depends_on_a_repo_secret():
    text = _WORKFLOW.read_text()
    assert "secrets.CI_TEST_LICENSE_KEY" not in text
    assert "Generate a throwaway signed LICENSE_KEY for this run" in text


def test_every_license_using_job_mints_its_own_key_before_using_it():
    expected_followups = {
        "compose-config-validation": 'name: Generate a throwaway CHILD_PIN for this run',
        "wizard-end-to-end": 'name: Generate a throwaway CHILD_PIN for this run',
        "full-stack-boot": 'name: Start the full stack (as the wizard configured it)',
    }

    for job, first_consumer in expected_followups.items():
        block = _job_block(job)
        installer = block.index("name: Install pycryptodome for throwaway license minting")
        generator = block.index("name: Generate a throwaway signed LICENSE_KEY for this run")
        assert 'python3 -m pip install pycryptodome' in block
        assert "ECC.generate(curve=\"ed25519\")" in block
        assert "PUBLIC_KEY_PEM" in block
        assert "CI_TEST_LICENSE_KEY=" in block
        assert installer < generator, job
        assert generator < block.index(first_consumer), job


def test_full_stack_job_replaces_the_wizard_artifact_license():
    block = _job_block("full-stack-boot")
    artifact = block.index("uses: actions/download-artifact@")
    replacement = block.index("name: Use the full-stack job's signed license")
    start = block.index("name: Start the full stack (as the wizard configured it)")

    assert artifact < replacement < start
    handoff = block[replacement:start]
    assert "CI_TEST_LICENSE_KEY" in handoff
    assert 'line.startswith("LICENSE_KEY=")' in handoff
    assert "len(license_lines) != 1" in handoff


def test_the_guard_would_fail_if_a_job_used_the_license_before_generating_it():
    reconstructed = """
jobs:
  full-stack-boot:
    steps:
      - uses: actions/checkout@v4
      - name: Install pycryptodome for throwaway license minting
        run: python3 -m pip install pycryptodome
      - name: Start the full stack (as the wizard configured it)
        run: docker compose up -d --build
      - name: Generate a throwaway signed LICENSE_KEY for this run
        run: |
          python3 - <<'PY'
          from Crypto.PublicKey import ECC
          ECC.generate(curve="ed25519")
          PY
"""
    block = reconstructed.split("\n  full-stack-boot:\n", 1)[1]
    generator = block.index("name: Generate a throwaway signed LICENSE_KEY for this run")
    consumer = block.index("name: Start the full stack (as the wizard configured it)")
    assert not generator < consumer


def test_the_guard_would_fail_if_pycryptodome_install_came_after_generation():
    reconstructed = """
jobs:
  compose-config-validation:
    steps:
      - uses: actions/checkout@v4
      - name: Generate a throwaway signed LICENSE_KEY for this run
        run: |
          python3 - <<'PY'
          from Crypto.PublicKey import ECC
          ECC.generate(curve="ed25519")
          PY
      - name: Install pycryptodome for throwaway license minting
        run: python3 -m pip install pycryptodome
"""
    block = reconstructed.split("\n  compose-config-validation:\n", 1)[1]
    installer = block.index("name: Install pycryptodome for throwaway license minting")
    generator = block.index("name: Generate a throwaway signed LICENSE_KEY for this run")
    assert not installer < generator
