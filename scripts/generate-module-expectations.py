#!/usr/bin/env python3
"""
Regenerate the module-reading parity fixtures.

Runs python-hcl2 -- the parser upstream uses -- over the Terraform fixtures in
dflook/terraform-github-actions, extracts the same facts our module reader
extracts, and writes both the fixtures and the expectations into __tests__ so the
suite runs without Python or a network.

Requires python-hcl2 7.3.1 specifically. See regenerate-expectations.md.
"""

from __future__ import annotations

import glob
import json
import os
import pathlib
import shutil
import sys

UPSTREAM = pathlib.Path('/tmp/dflook-upstream')
FIXTURES = pathlib.Path(__file__).parent.parent / '__tests__' / 'fixtures'

try:
    import hcl2  # type: ignore
except ImportError:
    sys.exit("python-hcl2 is not installed. Run: pip3 install 'python-hcl2==7.3.1'")


def load_module(directory: str) -> dict:
    """Merge every .tf file in a directory into one parsed module."""
    merged: dict = {}

    for path in sorted(glob.glob(os.path.join(directory, '*.tf'))):
        try:
            with open(path) as handle:
                parsed = hcl2.load(handle)
        except Exception:
            # Upstream ignores files that fail to parse, so this does too.
            continue

        for key, value in parsed.items():
            merged.setdefault(key, [])
            merged[key].extend(value if isinstance(value, list) else [value])

    return merged


def required_version(module: dict) -> str | None:
    for block in module.get('terraform', []):
        if isinstance(block, dict) and 'required_version' in block:
            return str(block['required_version'])
    return None


def backend_type(module: dict) -> str:
    for block in module.get('terraform', []):
        if not isinstance(block, dict):
            continue
        for backend in block.get('backend', []):
            if isinstance(backend, dict):
                for name in backend:
                    return str(name)

    for block in module.get('terraform', []):
        if isinstance(block, dict) and 'cloud' in block:
            return 'cloud'

    return 'local'


def sensitive_variables(module: dict) -> list[str]:
    names = []
    for variable in module.get('variable', []):
        if not isinstance(variable, dict):
            continue
        for name, attributes in variable.items():
            if isinstance(attributes, dict) and attributes.get('sensitive') in (True, 'true'):
                names.append(name)
    return sorted(names)


def main() -> None:
    if not UPSTREAM.is_dir():
        sys.exit(
            f'{UPSTREAM} not found. Clone it first:\n'
            '  git clone --depth 1 https://github.com/dflook/terraform-github-actions.git '
            f'{UPSTREAM}'
        )

    directories = sorted({os.path.dirname(p) for p in glob.glob(str(UPSTREAM / 'tests/**/*.tf'), recursive=True)})
    if not directories:
        sys.exit('No .tf fixtures found in the upstream clone')

    modules_root = FIXTURES / 'modules'
    shutil.rmtree(modules_root, ignore_errors=True)
    modules_root.mkdir(parents=True, exist_ok=True)

    expectations = []
    for directory in directories:
        name = os.path.relpath(directory, UPSTREAM / 'tests').replace(os.sep, '__')

        destination = modules_root / name
        destination.mkdir(parents=True, exist_ok=True)
        for source in pathlib.Path(directory).glob('*.tf'):
            shutil.copy(source, destination / source.name)

        module = load_module(directory)
        expectations.append({
            'module': name,
            'requiredVersion': required_version(module),
            'backend': backend_type(module),
            'sensitive': sensitive_variables(module),
        })

    (FIXTURES / 'module-expectations.json').write_text(json.dumps(expectations, indent=1) + '\n')

    print(f'{len(expectations)} modules written to {modules_root}')
    print(f'hcl2 version in use: {getattr(hcl2, "__version__", "unknown")}')


if __name__ == '__main__':
    main()
