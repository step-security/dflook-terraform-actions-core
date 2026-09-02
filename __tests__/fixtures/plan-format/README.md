# Plan formatting fixtures

`plan.txt` is sample Terraform plan output. `plan.diff.txt` is what upstream
produces for it.

The expectation was **not** written by hand. It came from running upstream's own
`format_diff`:

```python
import sys; sys.path.insert(0, 'image/src')
from github_pr_comment.plan_formatting import format_diff
print(format_diff(open('plan.txt').read()), end='')
```

That matters because the transform has edges that are easy to get wrong and
invisible in review: the operation character moves to column zero but the
original indentation is preserved after it, a bare `~` becomes `!~` so GitHub
colours it, `# (N unchanged attributes hidden)` is rewritten too, and heredoc
bodies are passed through untouched so a `-` inside a shell script is not
mistaken for a deletion marker.

Rendering does not affect approval. The plan hash is taken over the text as
Terraform produced it, before formatting.
