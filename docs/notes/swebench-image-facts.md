# SWE-bench image / conda / env-key facts (Plan B, Task 1 spike)

Research spike, no product code. Pins the exact values Task 2 (deck generator),
Task 3 (baked sandbox image), and Task 5 (measurement) depend on. All values
below were verified empirically on 2026-07-14 against `swebench` 4.1.0 (PyPI,
installed in a throwaway venv) and the `princeton-nlp/SWE-bench_Verified`
dataset (500 instances, HF `datasets` 5.0.0). Commands are recorded so the
facts can be reproduced.

## 1. Critical fork: image granularity — VERDICT: per-instance only, no per-env images

SWE-bench (harness `swebench==4.1.0`) publishes **only per-instance eval
images** on Docker Hub. **No per-env images are published or pullable.** This
is true both by static analysis of the harness source and by live registry
probes.

### Evidence

**Source (`swebench/harness/docker_build.py`, `build_env_images()` /
`build_instance_image()`):** env images are *always built locally* from a
generated Dockerfile (`env_dockerfile` → `get_dockerfile_env`), never pulled.
Only the instance image build path checks `test_spec.is_remote_image`
(true when a `namespace` is passed to `make_test_spec`) and, if so, does
`client.images.pull(test_spec.instance_image_key)` instead of building.
`env_image_key` (see §3) has no namespace-prepending logic at all — there is
no code path that ever pulls an env image from a registry.

**Live registry probe** (manifest-only, no image pulled — run from
`/tmp/kagenti/planB`):

```bash
# exists (EXIT:0, valid manifest.v2, amd64/linux, no manifest list)
skopeo inspect --raw docker://docker.io/swebench/sweb.eval.x86_64.django_1776_django-10097:latest

# does NOT exist ("requested access to the resource is denied" == 404 for a public repo, EXIT:1)
skopeo inspect --raw docker://docker.io/swebench/sweb.env.py.x86_64.56a3bf2c8561bd901139b0:latest

# arm64 instance image also does NOT exist (EXIT:1, same "access denied")
skopeo inspect --raw docker://docker.io/swebench/sweb.eval.arm64.django_1776_django-10097:latest
```

The instance image tag used above (`django_1776_django-10097`,
`56a3bf2c8561bd901139b0`) is the real value the harness computed for
`django/django` instance `django__django-10097` (see §3) — not a guess.

### Consequence for Task 3

Task 3 **cannot** pull a shared per-env image directly (it does not exist on
the registry). Two ways to still get the shared conda env into the baked
sandbox image; **recommended: option (a)**:

- **(a) Recommended — pull one representative *instance* image per env-key
  group, then extract the conda env from it.** Because `env_image_key` is
  empirically stable across every instance that shares the same `(repo,
  version)` (see §3 empirical check — the *content* of the shared `testbed`
  conda env is identical across those instances even though only
  instance-level artifacts are published), pulling **any single** already-published
  instance image for a given env-key group and running `conda-pack` on its
  `/opt/miniconda3/envs/testbed` (see §2) reproduces the shared env exactly.
  This reuses Docker Hub's existing public artifacts and needs no local
  swebench Docker build pipeline. **Task 2's generator must therefore record,
  per env-key, at least one representative `instance_id`** (and its
  `instance_image_key`) so Task 3 knows which published image to pull for
  that env.
- **(b) Alternative — build the env image locally** via swebench's own
  `build_env_images()` path (needs `docker` + the harness's Dockerfile
  templates + network access to fetch `environment.yml`/`requirements.txt`
  content). Heavier: requires running swebench's Docker build machinery
  inside Task 3 instead of a plain `docker pull`.

Either way, the deck's `env_key` (§3) is the value that names the artifact
Task 3 must resolve to a real pull — for option (a) that's "some instance
image whose `env_image_key` equals this `env_key`", for option (b) it's "the
env image locally built with this exact key."

## 2. Image name templates, tag, and arch coverage

All templates come from `swebench.harness.test_spec.test_spec.TestSpec`
properties (`swebench/harness/test_spec/test_spec.py`).

| Image level | Template | Published on Docker Hub? | Notes |
|---|---|---|---|
| Base | `sweb.base.{ext}.{arch}[.{hash10}]:{tag}` | No | `{hash10}` only present if `docker_specs != {}`. |
| Env | `sweb.env.{ext}.{arch}.{hash22}:{tag}` | **No** (verdict §1) | `{hash22}` = first 22 hex chars of `sha256(str(env_script_list) [+ str(docker_specs)])`. No namespace ever prepended. |
| Instance | `{namespace}/sweb.eval.{arch}.{instance_id_lower}:{tag}` (namespace only when `namespace is not None`) | **Yes** | Default `namespace="swebench"` (see `swebench/harness/run_evaluation.py:285`). `instance_id` is lower-cased and every `__` is replaced with `_1776_` (SWE-bench's escape for the org/repo separator, since Docker repo names disallow `__`). |

- **Tag:** `latest` (the `LATEST` constant; `env_image_tag`/`instance_image_tag` default to it and nothing else is published for Verified).
- **Registry/namespace confirmed:** `docker.io/swebench/...` (default `namespace="swebench"` in `run_evaluation.py`). No alternate namespace found in the harness source for the public Verified images.
- **Arch coverage confirmed:** the one instance image probed (`swebench/sweb.eval.x86_64.django_1776_django-10097:latest`) is a **single-arch `manifest.v2` (not a manifest list)**: `skopeo inspect` reports `"Architecture": "amd64"`, `"Os": "linux"`. The parallel `arm64` instance tag for the same instance does **not** exist on the registry (`skopeo inspect --raw` → access denied). **No arm64 variants exist for any repo on the public registry** for SWE-bench Verified — this is x86_64/amd64-only across the board, not a per-repo exception.
- Note the harness's Dockerfile templates (`_DOCKERFILE_BASE_PY`, etc.) **do** support building `arm64` locally (they template `--platform={platform}` and pick `conda_arch = "aarch64"` when `arch == "arm64"` — see `swebench/harness/dockerfiles/__init__.py:67-69`), so an arm64 build is *possible* in principle via local build, but nothing arm64 is ever published. **This drives Task 3 to be x86_64-only / OCP-only (or explicit QEMU emulation) for baked images sourced from the public registry.**

## 3. The pinned `swebench` symbol for the env-key derivation

**Symbol:** `swebench.harness.test_spec.test_spec.TestSpec.env_image_key` (a
`@property` on the `TestSpec` dataclass), obtained via
`swebench.harness.test_spec.test_spec.make_test_spec(instance, namespace=..., arch=...)`.

This is **not** the raw `MAP_REPO_VERSION_TO_SPECS` constant. That constant
(`swebench.harness.constants.MAP_REPO_VERSION_TO_SPECS[repo][version]`) is an
*input* to key derivation (via `docker_specs = specs.get("docker_specs", {})`
and the env/eval/repo script generators), not the key itself.

```python
from swebench.harness.test_spec.test_spec import make_test_spec
ts = make_test_spec(instance, namespace="swebench", arch="x86_64")
ts.env_image_key       # -> "sweb.env.py.x86_64.<hash22>:latest"
ts.instance_image_key  # -> "swebench/sweb.eval.x86_64.<instance_id_lower__with_1776>:latest"
```

**Requires the full instance row, not just `(repo, version)`.**
`make_test_spec(instance, ...)` takes a full SWE-bench instance dict (needs at
minimum `instance_id`, `repo`, `version`, `base_commit`, `test_patch`,
`FAIL_TO_PASS`/`PASS_TO_PASS`) because it calls
`swebench.harness.test_spec.create_scripts.make_env_script_list(instance,
specs, env_name="testbed")` internally, which (for Python repos) calls
`load_cached_environment_yml(instance["instance_id"])` (a per-instance-id
lookup into swebench's bundled resource cache) and, on cache miss, fetches
`environment.yml`/`requirements.txt` from GitHub raw content **at
`instance.get("environment_setup_commit", instance["base_commit"])`** — i.e.
it needs network access unless the instance is in swebench's bundled cache.
`specs = MAP_REPO_VERSION_TO_SPECS[repo][version]` is looked up as part of
this, so the raw constant alone is insufficient — you must go through
`make_test_spec`.

**Concrete example (django, verified empirically):**

```python
from datasets import load_dataset
from swebench.harness.test_spec.test_spec import make_test_spec

ds = load_dataset("princeton-nlp/SWE-bench_Verified", split="test")
inst = next(r for r in ds if r["repo"] == "django/django")   # picks django__django-10097
ts = make_test_spec(inst, namespace="swebench", arch="x86_64")
```

| Field | Value |
|---|---|
| `instance_id` | `django__django-10097` |
| `repo` | `django/django` |
| `version` | `2.2` |
| `ts.base_image_key` | `sweb.base.py.x86_64:latest` |
| `ts.env_image_key` | `sweb.env.py.x86_64.56a3bf2c8561bd901139b0:latest` |
| `ts.instance_image_key` | `swebench/sweb.eval.x86_64.django_1776_django-10097:latest` |
| `ts.is_remote_image` | `True` (because `namespace="swebench"` was passed) |
| arm64 equivalents | `sweb.env.py.arm64.56a3bf2c8561bd901139b0:latest` / `swebench/sweb.eval.arm64.django_1776_django-10097:latest` — **neither is published** (§2) |

**Empirical stability check (why option (a) in §1 works):** sampled every
instance (up to 8 per group) in several `(repo, version)` groups from Verified
and computed `env_image_key` for each — every instance within a group
produced the *identical* `env_image_key`:

```
astropy/astropy 5.0: n=4  sampled=4 distinct_env_keys=1
astropy/astropy 5.1: n=8  sampled=8 distinct_env_keys=1
astropy/astropy 1.3: n=4  sampled=4 distinct_env_keys=1
django/django   3.0: n=36 sampled=8 distinct_env_keys=1
django/django   3.1: n=32 sampled=8 distinct_env_keys=1
django/django   3.2: n=43 sampled=8 distinct_env_keys=1
```

SWE-bench Verified (500 instances total) collapses to **80 distinct
`(repo, version)` groups** (`len(set((r["repo"], r["version"]) for r in
ds)) == 80`) — i.e. an average of ~6.25 instances share one env, confirming
the sharing premise behind Plan B's "bake per env, not per instance" design
even though the registry itself only exposes per-instance artifacts.

**Task 2 requirement:** `env_key()` must call
`make_test_spec(instance, namespace="swebench", arch=<target>).env_image_key`
(full instance row required) — not read `MAP_REPO_VERSION_TO_SPECS` directly.

## 4. Conda layout + relocation recipe (pinned, verified working end-to-end)

Pulled ONE published instance image and inspected/relocated its conda env
under `--platform linux/amd64` emulation (host is arm64 macOS; SWE-bench
images are x86_64-only per §2):

```bash
docker pull --platform linux/amd64 docker.io/swebench/sweb.eval.x86_64.django_1776_django-10097:latest
```

| Fact | Value |
|---|---|
| Conda base install prefix | `/opt/miniconda3` |
| Conda binary | `/opt/miniconda3/condabin/conda`, version `23.11.0` (matches harness default `DEFAULT_DOCKER_SPECS["conda_version"] = "py311_23.11.0-2"`) |
| Conda env name inside the image | `testbed` (hardcoded as `env_name = "testbed"` in `make_test_spec`, universal across all repos/languages, not per-repo) |
| Env prefix | `/opt/miniconda3/envs/testbed` (confirmed via `python -c "import sys;print(sys.prefix)"` run inside the container) |
| Repo checkout dir | `/testbed` (`repo_directory = f"/{env_name}"`) |
| Miniconda installer arch template | `x86_64` → `Miniconda3-{conda_version}-Linux-x86_64.sh`; `arm64` → `...Linux-aarch64.sh` (`swebench/harness/dockerfiles/__init__.py:67-69`) — only the x86_64 path is ever exercised by published images (§2). |

**Relocation method: `conda-pack` / `conda-unpack`. Verified working
end-to-end** (packed the `testbed` env, unpacked it to a *different* prefix in
the same container, and confirmed the relocated interpreter reports the new
prefix and still imports the project):

```bash
# Inside the running instance-image container (root):
/opt/miniconda3/bin/conda install -n base -c conda-forge conda-pack -y -q
/opt/miniconda3/bin/conda pack -n testbed -o /tmp/testbed_env.tar.gz   # -> 103046205 bytes

mkdir -p /opt/relocated/testbed
tar -xzf /tmp/testbed_env.tar.gz -C /opt/relocated/testbed
/opt/relocated/testbed/bin/conda-unpack

# Verification:
/opt/relocated/testbed/bin/python -c "import sys; print(sys.prefix)"
# -> /opt/relocated/testbed   (correctly rewritten from /opt/miniconda3/envs/testbed)
/opt/relocated/testbed/bin/python -c "import django; print(django.get_version())"
# -> 2.2.dev20250910093934    (import succeeds after relocation)
```

**Task 3 recipe (concrete, ready to template into a Dockerfile):**

```dockerfile
# In a build stage FROM the published instance image for a representative
# instance of the target env-key:
RUN /opt/miniconda3/bin/conda install -n base -c conda-forge conda-pack -y -q \
 && /opt/miniconda3/bin/conda pack -n testbed -o /tmp/<env-key>.tar.gz

# In the final baked-sandbox stage:
RUN mkdir -p /opt/miniconda3/envs/<env-key> \
 && tar -xzf /tmp/<env-key>.tar.gz -C /opt/miniconda3/envs/<env-key> \
 && /opt/miniconda3/envs/<env-key>/bin/conda-unpack
```

Using the destination prefix `/opt/miniconda3/envs/<env-key>` (rather than
reusing `testbed`) lets multiple relocated envs coexist side by side in one
baked image, keyed by the same `env_key` string the deck/generator use — this
is what keeps the "drift guard" in Task 2/3 meaningful.

## 5. Arch coverage summary table

| Artifact | x86_64 / amd64 | arm64 |
|---|---|---|
| Published instance images (`swebench/sweb.eval.*`) | Yes (confirmed pullable, single-arch manifest) | **No** (confirmed absent via `skopeo inspect --raw` — access denied) |
| Published env images (`sweb.env.*`) | **No** (none published at all, any arch — §1) | **No** |
| Harness's local Dockerfile *templates* | Supported | Supported in the template (`conda_arch="aarch64"`), but never exercised for published Verified images |

**Consequence:** any Task 3 pipeline that sources from the public registry is
inherently x86_64-only. On arm64 dev hosts (e.g. this Mac), all
docker/skopeo operations against these images require
`--platform linux/amd64` and run under emulation (slow — the conda-pack
inspection above took several minutes under QEMU for one env). This supports
an OCP (x86_64 nodes) or emulated-Kind-only decision for Task 3, not a
native-arm64 fast path.

## No unresolved TBDs

Every value a later task needs is pinned above: image template + tag +
registry/namespace (§2), granularity verdict + Task-3 consequence (§1), exact
`swebench` symbol + concrete example value + full-instance-row requirement
(§3), conda prefix/env-name + working `conda-pack`/`conda-unpack` commands
(§4), and arch coverage (§2, §5).

## Self-review

- Granularity verdict is backed by both static source analysis
  (`docker_build.py`) and a live negative registry probe (`skopeo inspect
  --raw` → access denied for the env-image guess and for an arm64 instance
  tag), not just one or the other.
- The pinned symbol (`TestSpec.env_image_key` via `make_test_spec`) was
  exercised against the real `SWE-bench_Verified` dataset (not a synthetic
  instance), and its "full-row-required" claim was traced to a concrete
  internal call (`load_cached_environment_yml` / `get_environment_yml`) that
  reads `instance_id` and `base_commit`/`environment_setup_commit`.
  Since it's a hash of "env_script_list" strings this method also
  needs network to fetch content in cases like `environment.yml`, unless
  content is cached.
- The stability claim ("one image per env-key group suffices") is empirical
  across two repos, 6 `(repo, version)` groups, and up to 8 sampled instances
  each — not a single-instance anecdote — and is corroborated by the harness
  design intent (env images are meant to be shared across instances of one
  `(repo, version)`).
- The conda relocation recipe was run to completion inside the actual
  published image (not simulated): `conda-pack` produced a real 103MB
  tarball, `conda-unpack` rewrote paths, and both `sys.prefix` and `import
  django` were checked post-relocation.
- No values were fabricated; the one thing NOT independently re-verified is
  whether `MAP_REPO_VERSION_TO_SPECS` values are byte-identical to what
  built the *currently published* Docker Hub images (the registry images
  could predate the installed `swebench==4.1.0`'s constants) — Task 2/3
  should treat a computed `env_image_key` mismatch against a real pull as
  the drift signal it's designed to catch, not assume perpetual agreement.
