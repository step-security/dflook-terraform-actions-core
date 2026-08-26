# Plan hash parity fixture

`plan-hash-parity.json` records hashes produced by **upstream's own Python
implementation**, not by this codebase.

This matters because the hash decides whether an apply is authorised. A plan
comment posted by upstream's action must still be recognised here as approving
the same plan, or a repository migrating to this action would find open pull
requests suddenly refusing to apply, with the misleading message that the plan
does not match.

To regenerate, run upstream's logic from
`image/src/github_pr_comment/hash.py` and `cmp.py`:

```python
import hashlib, re

def comment_hash(value: bytes, salt: str) -> str:
    h = hashlib.sha256(f'dflook/terraform-github-actions/{salt}'.encode())
    h.update(value)
    return h.hexdigest()

def remove_unchanged_attributes(plan: str) -> str:
    return '\n'.join(
        line for line in plan.splitlines()
        if not re.match(r'\s+# \(\d+ unchanged attributes hidden\)', line)
    ).strip()

def remove_warnings(plan: str) -> str:
    lines, reached = [], False
    for line in plan.splitlines():
        if reached and (line.startswith('Warning') or line.startswith('╷')):
            break
        lines.append(line)
        if re.match(r'Plan: \d+ to \S+', line):
            reached = True
    return '\n'.join(lines).strip()

def plan_hash(plan_text: str, salt: str) -> str:
    return comment_hash(remove_warnings(remove_unchanged_attributes(plan_text)).encode(), salt)
```

The `dflook/terraform-github-actions` prefix is a namespace, not a secret. It is
kept as-is deliberately; see the comment on `HASH_NAMESPACE` in
`src/comment/hash.ts`.
