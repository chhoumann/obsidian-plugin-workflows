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

Scope is deliberate: **reusable CI/quality workflows only.** The release
*pipelines* stay per-repo because they encode genuinely different philosophies
(quickadd publishes with an app token and provenance; podnotes runs a machine-PR
release pipeline). What the release pipelines share - the `version-bump.mjs`
script, the semantic-release plugin chain, and the dependabot config - lives in
[`templates/`](./templates) as copy-in files, not as a workflow.

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

Add this repo's `github-actions` ecosystem to each consumer's Dependabot so the
`@v1`/SHA pins here get bumped like any other action.

## Templates

Copy-in files (not reusable workflows) in [`templates/`](./templates), with a
per-file guide in [`templates/README.md`](./templates/README.md):

- `version-bump.mjs` - syncs `manifest.json` + `versions.json` with the release.
- `semantic-release.jsonc` - the canonical release plugin chain (paste into
  `package.json` `"release"` or `.releaserc.json`).
- `dependabot.yml` - grouped weekly npm + github-actions updates.
- `caller-workflows/` - minimal stubs consuming the four reusable workflows.

## Versioning of this repo

Consumers pin a ref, so this repo carries a moving major tag.

- Tag releases `v1.0.0`, `v1.1.0`, ... and keep a `v1` tag pointed at the latest
  compatible release. Consumers pin `@v1`.
- Move `v1` forward on any backwards-compatible change:
  `git tag -f v1 v1.2.0 && git push -f origin v1`.
- Cut `v2` only for a breaking change to a workflow's input surface or behavior.
  Leave `v1` in place so unmigrated consumers keep working, then migrate them.

## Migration checklist for a consumer repo

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
