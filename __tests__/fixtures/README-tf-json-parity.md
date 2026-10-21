# JSON module parity fixtures

`module-json-parity.json` and `tf-json-parity.json` record what upstream
`dflook/terraform-github-actions` **actually does**, captured by running its own
Python over each input rather than by reading the code and writing down what it
appeared to do. That distinction has already earned its keep: a careful reading
got three things wrong that the recording caught, including that `tf_json.load`
reorders blocks and that several malformed shapes raise rather than returning
partial facts.

## Regenerating

Clone upstream at the tag being targeted and run its parser directly:

```bash
git clone https://github.com/dflook/terraform-github-actions /tmp/dflook-up
cd /tmp/dflook-up && git checkout v3.1.0
pip3 install python-hcl2 requests
```

`terraform/tf_json.py` imports `github_actions.debug`, which pulls in the whole
action; stub it before importing:

```python
import sys, types
ga = types.ModuleType('github_actions'); ga.__path__ = []
dbg = types.ModuleType('github_actions.debug'); dbg.debug = lambda *a, **k: None
sys.modules['github_actions'] = ga
sys.modules['github_actions.debug'] = dbg
```

Then run with `PYTHONPATH=/tmp/dflook-up/image/src`.

Two things to avoid when recording:

- Do not serialise with `sort_keys=True`. It reorders the *inputs*, and the
  first label in a backend block is significant, so a recorded expectation stops
  matching the input it was recorded from.
- Do not name the script `inspect.py`. Its directory lands on `sys.path` and
  shadows the standard library module that `hcl2` loads.

## The one case where we differ on purpose

`hcl-backend-json-backend` has two files that each declare a backend. Upstream
answers from whichever file `Path.iterdir()` happens to yield first, which is
not sorted and varies by filesystem; the same two files produced `s3` under one
set of names and `local` under another. There is no behaviour to match there, so
we sort the directory and let HCL win, which at least gives the same answer every
time.
