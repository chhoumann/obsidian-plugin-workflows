# obsidian-plugin-workflows

Reusable GitHub Actions workflows plus a small release toolkit for the Obsidian
plugin repos [`quickadd`](https://github.com/chhoumann/quickadd),
[`metaedit`](https://github.com/chhoumann/metaedit), and
[`podnotes`](https://github.com/chhoumann/podnotes).

## What and why

The three repos carried near-identical CI, CodeQL, dependency-review, and
PR-title workflows plus the same release-support scripts. Kept as copies they
drifted: one repo got a hardening fix, another a Node bump, a third an updated
action SHA, and no single source of truth existed. This repo is that source of
truth. Each plugin repo consumes the workflows via `workflow_call` and pins a
version, so a fix lands once here and every consumer picks it up.

This repo carries two things: the **reusable CI/quality workflows** (`ci.yml`,
`codeql.yml`, `dependency-review.yml`, `pr-title.yml`) and the **shared forensic
release pipeline** (`release-prepare.yml`, `release-validate.yml`, `release.yml`
plus the `scripts/` release toolkit). All four plugin repos standardize on the
same PR-to-release model; a consumer keeps only thin caller stubs and pins a ref.
See [Release pipeline](#release-pipeline) and the design doc
[`release-pipeline-plan.md`](./release-pipeline-plan.md).

A few genuinely copy-in bits (the `version-bump.mjs` used by manual bumps, the
dependabot config) still live in [`templates/`](./templates).

## Consumption model

A consumer references a workflow by path and pins a ref:

```yaml
jobs:
  ci:
    uses: chhoumann/obsidian-plugin-workflows/.github/workflows/ci.yml@v1
    with:
      package-manager: pnpm
```

Pin `@v1` (the moving major tag, see [Versioning](#versioning-of-this-repo)) for
automatic non-breaking updates, or a full commit SHA if you want to pin exactly
and let Dependabot bump it. The consumer supplies the **triggers**
(`on:` block); the reusable workflow supplies the jobs. Some triggers *must* live
in the caller - see each workflow's notes below.

Ready-to-copy caller stubs are in
[`templates/caller-workflows/`](./templates/caller-workflows).

## Reusable workflows

### `ci.yml`

Two jobs - **Test** and **Build + Lint** - each with harden-runner (egress
audit), SHA-pinned actions, `persist-credentials: false` checkout, a
package-manager setup with dependency caching, and a frozen-lockfile install
(`pnpm install --frozen-lockfile` or `npm ci`).

| Input | Type | Default | Purpose |
| --- | --- | --- | --- |
| `package-manager` | string | `pnpm` | `pnpm` or `npm`. Drives setup, cache, and install. |
| `node-version` | string | `"24"` | Passed to `actions/setup-node`. |
| `test-command` | string | `<package-manager> run test` | Command for the Test job. |
| `build-command` | string | `<package-manager> run build` | Build step of the Build + Lint job. |
| `lint-command` | string | `""` (skipped) | Optional lint step after build. |
| `check-commands` | string | `""` (skipped) | Optional extra checks, one command per line (Svelte check, format check, type check). |

Command defaults that reference `package-manager` are resolved at runtime because
`workflow_call` input defaults cannot reference other inputs.

**No path filters on the caller.** Test and Build + Lint are meant to be required
status checks. A required check gated behind a path filter never runs on a
docs-only PR and stays pending forever, deadlocking merge. The caller stub
triggers on every `push`/`pull_request` with no `paths`/`paths-ignore`.

Example caller: [`templates/caller-workflows/ci.yml`](./templates/caller-workflows/ci.yml).

### `codeql.yml`

CodeQL analysis with the `security-extended` query suite across a language
matrix.

| Input | Type | Default | Purpose |
| --- | --- | --- | --- |
| `languages` | string | `'["javascript-typescript","actions"]'` | JSON array of CodeQL languages for the matrix. |

**The weekly cron must live in the caller.** `on.schedule` is ignored inside a
called workflow; the scheduled scan only fires from the caller's own
`schedule:` trigger. The caller stub declares the cron (`0 6 * * 1`) alongside
`push`/`pull_request`, and must grant `security-events: write`.

Example caller: [`templates/caller-workflows/codeql.yml`](./templates/caller-workflows/codeql.yml).

### `dependency-review.yml`

Reviews dependency changes on every PR and blocks newly-introduced advisories.
Stricter than the action default (which only fails on runtime/high).

| Input | Type | Default | Purpose |
| --- | --- | --- | --- |
| `fail-on-severity` | string | `moderate` | Minimum advisory severity that fails the check. |
| `fail-on-scopes` | string | `runtime, development` | Dependency scopes enforced. |

The caller triggers on `pull_request` with no path filters (so lockfile bumps are
always scanned) and must grant `pull-requests: write`.

Example caller: [`templates/caller-workflows/dependency-review.yml`](./templates/caller-workflows/dependency-review.yml).

### `pr-title.yml`

Validates the PR title as a Conventional Commit via
`amannn/action-semantic-pull-request`. The title becomes the squash-merge commit,
which drives the semantic-release version - so a bad title can't produce a wrong
or missing release.

| Input | Type | Default | Purpose |
| --- | --- | --- | --- |
| `types` | string | standard set (`feat`, `fix`, `perf`, `docs`, `style`, `refactor`, `test`, `build`, `ci`, `chore`, `revert`) | Newline-separated allowed commit types. |

**The caller must trigger on `pull_request_target`,** not `pull_request`: a fork
PR's title is only reliably readable, and `GITHUB_TOKEN` only carries the right
context, under `pull_request_target`. This is safe here because the workflow
never checks out or runs PR head code.

Example caller: [`templates/caller-workflows/pr-title.yml`](./templates/caller-workflows/pr-title.yml).

## Release pipeline

The forensic PR-to-release pipeline all four plugin repos share. Full design in
[`release-pipeline-plan.md`](./release-pipeline-plan.md); this is the operator's
guide.

**The model.** After every green push to the default branch, a per-repo GitHub
App bot opens (or refreshes) exactly one standing release PR containing only the
synchronized version files and generated notes - skipped when no conventional
commits warrant a release. **Merging that PR is the sole release act.** The merge
fires a forensic validator that binds the merged commit to the exact planned
diff, then a publisher rebuilds, re-verifies, attests, and publishes the release.

```
push to default branch -> CI green
   -> release-prepare  (App bot opens/refreshes ONE draft release PR)
   -> maintainer reviews green checks, marks ready, squash-merges
   -> release-validate (full merged-PR forensics + recovery branch + dispatch)
   -> release          (resolve + build + tag + attest + publish + notify)
```

### Reusable workflows and their triggers

`workflow_run` and `pull_request_target` cannot live in a called workflow, so
each consumer keeps three thin caller stubs (in
[`templates/caller-workflows/`](./templates/caller-workflows)) that carry only the
trigger + `uses:`; all logic lives in the reusables here.

| Reusable | Called from stub triggered by | Consumer stub |
| --- | --- | --- |
| `release-prepare.yml` | `workflow_run` (CI completed) + `workflow_dispatch` escape hatch | `release-prepare.yml` |
| `release-validate.yml` | `pull_request_target: [closed]` + `workflow_dispatch` recovery | `release-trigger.yml` |
| `release.yml` | `workflow_dispatch` (dispatched by validate) | `release.yml` |

A caller stub sets the token ceiling with a top-level or per-job `permissions:`
that grants the union its reusable needs; the reusable scopes each job down from
there. Copy the stubs and pin `@v4`; the toolkit scripts are checked out from
the reusable workflow's own commit (`job.workflow_repository` /
`job.workflow_sha`), so the `uses:` ref is the single version pin.

### Inputs

Shared across all three reusables:

| Input | Default | Purpose |
| --- | --- | --- |
| `plugin-name` | (required) | Marker prefix: `<plugin>-release-commit` / `<plugin>-release-pr`. |
| `package-name` | `plugin-name` | Expected `package.json` `name`. |
| `manifest-id` | `plugin-name` | Expected `manifest.json` `id`. |
| `default-branch` | `master` | Branch release PRs target. |
| `package-manager` | `npm` | `npm` or `pnpm`; drives the release-file set (npm syncs `package-lock.json`, pnpm has no lockfile in the set). |
| `release-bot-app-slug` | (required) | App slug; the expected bot login is `<slug>[bot]`. |

`release-prepare.yml` adds: `target-sha` (empty = default-branch head),
`node-version`, `release-policy` (below), `app-id` (a repo **variable** value),
the `release-app-private-key` **secret**, and `dry-run`. `release-validate.yml`
adds: `pr-number`, `release-merger-login` (empty = repo owner), and
`release-workflow` (the consumer workflow to dispatch). `release.yml` adds:
`release-pr`, `node-version`, `release-policy`, `release-assets` (JSON list),
`build-command`, `verify-commands` (multiline), `setup-python` /
`python-version` / `docs-requirements`, `notify-name`, and the optional
`slack-webhook` / `discord-webhook` secrets.

**`release-policy`** is the commit-to-release classification: a JSON list of
semantic-release `releaseRules` (e.g.
`[{"scope":"deps","type":"build","release":"patch"}]`) applied on top of the
standard conventional-commit rules (`feat` -> minor, `fix`/`perf` -> patch,
breaking -> major). Pin it explicitly in both the `release-prepare.yml` and
`release.yml` stubs, with the same value, so a toolkit ref bump can never change
which commits cut a release; an empty value falls back to the toolkit default
(kept for compatibility). The policy only decides the version bump - notes and
the release diff are policy-independent - so a prepare/release mismatch either
produces the identical release or fails closed on the release stage's
expected-version recompute.

### Security model - what each forensic check defends against

Everything after "maintainer clicks merge" is treated as adversarial until proven
otherwise. The layered checks:

- **Standing PR provenance** - PR author is the App bot, base is the default
  branch, head repo is this repo, branch is `release/<semver>`, title is the exact
  contract string. Blocks a human- or fork-authored PR impersonating a release.
- **Exact version-file diff** - the PR changes exactly the release-file set;
  `release-contract.mjs validate-files` re-derives that only version fields moved.
  Blocks smuggling source or lockfile changes into a "version bump".
- **Commit-message contract + parent** - the head commit message is the exact
  marker and its single parent is the recorded base. Blocks a rewritten or
  reparented release commit.
- **Squash-parent + tree-sha** - the squash merge commit has one parent (the base)
  and its tree equals the validated head tree. Blocks a merge that altered content.
- **Prior-tag ancestry and history** - the previous version tag exists, has valid
  synchronized metadata, is an ancestor of the base, its recorded `versions.json`
  history is byte-identical to the base, and the compatibility floor
  (`minAppVersion`) has not decreased. Blocks version-history forgery, silent
  history rewrites, a lowered floor slipped in between releases, and out-of-order
  releases.
- **Durable recovery branch** `release-run/<version>` - pins the exact release SHA
  so a failed or re-run release recovers to the same commit; deleted only after a
  verified publish.
- **Attestation + post-publish verification** - `attest-build-provenance` signs the
  assets; publish runs `gh attestation verify` against the exact source digest, then
  downloads every remote asset and re-hashes it. Blocks tampered or swapped assets.

The version-file semantics themselves (synchronized versions, floor rules
including the pending `minAppVersion` raise, append-only history) live only in
`scripts/release-contract.mjs`: validate downloads the version files at the
base, release, and previous-tag commits and runs the pinned contract script
(`validate-release`), the same model prepare and the release stage use, so the
workflows cannot drift from the contract.

The read-only forensic API calls in validate and resolve are wrapped in a bounded
retry (up to four attempts on a transient 5xx) so a momentary API outage cannot
strand a release the maintainer already merged; only reads are retried, never the
recovery-branch or dispatch writes.

The App token is used **only** in prepare, to author the release commit and PR as
the bot the maintainer controls. Tags and the GitHub release are created by the
default `GITHUB_TOKEN` (branch protection guards branches, not tags), so the
release object's author stays `github-actions[bot]`.

### Per-repo GitHub App setup

Each repo needs its own release-bot App so PR authorship binds to an identity you
control and can be made a branch-protection bypass actor. Per repo:

1. Create a GitHub App (Settings -> Developer settings -> GitHub Apps -> New).
   Name it e.g. `<plugin> Release Bot`; note the resulting **slug** (lowercased,
   spaces to hyphens, e.g. `podnotes-release-bot`) - it must equal
   `release-bot-app-slug`.
2. Repository permissions: **Contents: Read and write** and **Pull requests: Read
   and write**. No account permissions, no webhook.
3. Generate a private key (downloads a `.pem`).
4. Install the App on the plugin repo only (Install App -> select the repo).
5. In the repo: add a variable `RELEASE_APP_ID` (Settings -> Secrets and variables
   -> Actions -> Variables) with the App's numeric id, and a secret
   `RELEASE_APP_PRIVATE_KEY` with the full `.pem` contents.
6. If the default branch is protected, add the App as an allowed bypass/merge actor
   as your ruleset requires (the maintainer still merges the PR; the App only
   authors it).

### Dry-run smoke test

Before a repo's first real release, dispatch the **Prepare release** workflow
manually (Actions -> Prepare release -> Run workflow) with `dry-run: true` wired in
the stub, or temporarily uncomment `# dry-run: true`. The plan job computes the
version and notes and uploads them as an artifact; the open-PR job is skipped, so
nothing is pushed and no App call is made (dummy `app-id` / slug are fine for a
pure planning check). Confirm the planned version and notes look right, then remove
the dry-run.

### Recovery

Every stage is replayable from durable identities; nothing depends on transient
workflow state.

- **A release run failed after the PR merged** (or a validation bug was fixed in
  a newer toolkit pin): re-dispatch the **Trigger release** workflow from the
  default branch (Actions -> Trigger release -> Run workflow) with the merged
  release PR number. Validate re-derives everything from the PR, accepts the
  dispatch only from the current default-branch head, and fails closed on a bad
  number. The whole recovered pipeline - validate and the release stage it
  dispatches on the default branch - runs the stubs and pins **currently on the
  default branch**, so bump those first if the fix lives here; the release
  stage's trusted-branch-recovery check re-derives and re-verifies the exact
  release commit from the PR.
- **Webhook redelivery** is the alternative when you want the run to carry the
  exact merge-time event identity: redeliver the original `pull_request_target`
  closed-event delivery for the release PR. The payload carries the merge-time
  SHA, and validate then dispatches the release stage on the exact
  `release-run/<version>` source, as on a fresh merge.
- **The release stage alone failed:** the `release-run/<version>` recovery
  branch pins the exact release SHA until a verified publish; dispatch the
  consumer's **Release** workflow on it (or on the current default branch, to
  pick up newer pins) with the same PR number - or simply re-dispatch **Trigger
  release** as above. Re-running an already-published version is safe: the
  publisher verifies the existing release byte-for-byte and finishes without
  mutating it.
- **A release cut under an older `release-policy`** (e.g. before chore commits
  stopped releasing) fails the release stage's plan recompute with "Release
  plan version is none" - fail-closed, since the current policy would never
  have produced that version. To rebuild such a release, temporarily set the
  `release-policy` in the release stub to the rules that were in force when it
  was cut.

### Migration checklist (release pipeline)

1. Ensure the current released version is tagged and has a published GitHub release
   (the planner requires a tagged baseline).
2. Create and install the release-bot App; set `RELEASE_APP_ID` +
   `RELEASE_APP_PRIVATE_KEY` (above).
3. Copy the three caller stubs from
   [`templates/caller-workflows/`](./templates/caller-workflows)
   (`release-prepare.yml`, `release-trigger.yml`, `release.yml`) into
   `.github/workflows/`. Set `plugin-name` (lowercase, `[a-z0-9-]+`),
   `package-manager`, `release-policy`, `default-branch`, `node-version`,
   `release-bot-app-slug`, `release-assets` (add `styles.css` if the plugin
   ships one), and `verify-commands` to match the repo's scripts.
   - **One pin:** the `uses: ...@v4` ref selects this repo's version for the
     workflow AND its toolkit scripts (checked out from the reusable workflow's
     own commit), so Dependabot SHA bumps are always self-consistent.
   - **If the default branch is not `master`,** the literal appears in **five
     places** across the three stubs: the `default-branch:` input in all three,
     plus the `if:` gate in `release-prepare.yml` (`head_branch == 'master'`) and
     in `release-trigger.yml` (`base.ref == 'master'`). Change all five.
4. Retire the repo's old release workflow(s), and make sure no branch is
   literally named `release` or `release-run` (old semantic-release setups often
   have a stray `release` branch): git cannot hold both `refs/heads/release` and
   `refs/heads/release/<version>`, so a stray branch blocks the pipeline's
   branch creation. Prepare and validate preflight this and fail with an
   actionable message, but deleting the stray up front saves a failed run.
5. Smoke-test with `dry-run: true`, then push a conventional commit to the default
   branch and merge the release PR the bot opens.

## Pinned action versions

Every third-party action is SHA-pinned with a version comment. These SHAs are
kept fresh by Dependabot in the source repos and reused here verbatim:

| Action | Version | SHA |
| --- | --- | --- |
| `step-security/harden-runner` | v2.19.4 | `9af89fc71515a100421586dfdb3dc9c984fbf411` |
| `actions/checkout` | v7.0.0 | `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0` |
| `pnpm/action-setup` | v6.0.9 | `0ebf47130e4866e96fce0953f49152a61190b271` |
| `actions/setup-node` | v6.4.0 | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` |
| `github/codeql-action/*` | v4 | `54f647b7e1bb85c95cddabcd46b0c578ec92bc1a` |
| `actions/dependency-review-action` | v5.0.0 | `a1d282b36b6f3519aa1f3fc636f609c47dddb294` |
| `amannn/action-semantic-pull-request` | v6.1.1 | `48f256284bd46cdaab1048c3721360e808335d50` |
| `actions/github-script` | v8.0.0 | `ed597411d8f924073f98dfc5c65a23a2325f34cd` |
| `actions/create-github-app-token` | v3.2.0 | `bcd2ba49218906704ab6c1aa796996da409d3eb1` |
| `actions/upload-artifact` | v7.0.1 | `043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` |
| `actions/download-artifact` | v8.0.1 | `3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c` |
| `actions/attest-build-provenance` | v4.1.1 | `0f67c3f4856b2e3261c31976d6725780e5e4c373` |
| `actions/setup-python` | v6.3.0 | `ece7cb06caefa5fff74198d8649806c4678c61a1` |
| `rtCamp/action-slack-notify` | v2.4.0 | `33ca3be66c6f378fe1610fd1d5258632dbed5e58` |

Add this repo's `github-actions` ecosystem to each consumer's Dependabot so the
`@v1`/`@v4`/SHA pins here get bumped like any other action.

## Templates

Copy-in files (not reusable workflows) in [`templates/`](./templates), with a
per-file guide in [`templates/README.md`](./templates/README.md):

- `version-bump.mjs` - syncs `manifest.json` + `versions.json` for a manual
  `npm version` / `pnpm version` bump (the shared pipeline does this itself).
- `semantic-release.jsonc` - legacy semantic-release plugin chain, kept for repos
  not yet on the shared release pipeline.
- `dependabot.yml` - grouped weekly npm + github-actions updates.
- `caller-workflows/` - minimal stubs consuming the reusable workflows, including
  the three release-pipeline stubs (`release-prepare.yml`, `release-trigger.yml`,
  `release.yml`).

## Versioning of this repo

Consumers pin a ref, so this repo carries a moving major tag.

- Tag releases `v1.0.0`, `v1.1.0`, ... and keep a `v1` tag pointed at the latest
  compatible release. Consumers pin `@v1`.
- Move `v1` forward on any backwards-compatible change:
  `git tag -f v1 v1.2.0 && git push -f origin v1`.
- Cut `v2` only for a breaking change to a workflow's input surface or behavior.
  Leave `v1` in place so unmigrated consumers keep working, then migrate them.

## Migration checklist (CI and quality workflows)

1. Replace `.github/workflows/ci.yml` with the
   [`ci.yml` caller stub](./templates/caller-workflows/ci.yml); set
   `package-manager`, `node-version`, and any command overrides to match the
   repo's scripts. Keep triggers path-filter-free.
2. Replace `codeql.yml`, `dependency-review.yml`, and `pr-title.yml` with their
   caller stubs. Keep the CodeQL `schedule:` cron and the PR-title
   `pull_request_target` trigger.
3. Confirm `version-bump.mjs` matches `templates/version-bump.mjs` and the
   `"release"` block matches `templates/semantic-release.jsonc` (adjust the
   lockfile asset and `styles.css` presence).
4. Align `.github/dependabot.yml` with `templates/dependabot.yml`, and add a
   `github-actions` entry so the new `@v1` pins get updated.
5. Open a PR. Verify all four checks run and that required-check names still match
   your branch protection (the job names are `Test`, `Build + Lint`,
   `Analyze (...)`, `Dependency Review`, `Validate PR title`).
