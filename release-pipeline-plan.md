# Shared release pipeline - design

This repo hosts the reusable, forensic PR-to-release pipeline that all four
Obsidian plugin repos (`podnotes`, `metaedit`, `quickadd`, `notetweet`)
standardize on. The model is PodNotes' machine-PR release pipeline, generalized
so a fix lands once here and every consumer picks it up by bumping a pin.

## The release model in one paragraph

After every green push to the default branch, a per-repo GitHub App bot opens (or
refreshes) exactly **one** standing release PR. That PR contains only the
synchronized version files and generated release notes; it is skipped when no
conventional commits since the last tag warrant a release. The maintainer merges
that PR - and **merging it is the sole release act**. The merge fires a forensic
validator that binds the merged commit to the exact planned diff, then hands a
fully re-verified, attested build to a publisher that creates the GitHub release.
There is no auto-release and no manual dispatch on the happy path.

## Stages

```
  push to master (default branch)
        |
        v
  [CI "Test"/"CI" workflow] --- green --------------------------.
        |                                                        |
        | workflow_run: completed                                |
        v                                                        |
  release-prepare  (caller stub: workflow_run + workflow_dispatch escape hatch)
    -> uses reusable release-prepare.yml
       job plan    : plan version + notes from conventional commits
       job open-pr : mint APP token, build version-file-only commit,
                     open/refresh ONE draft release PR authored by the app bot
        |
        | maintainer reviews green checks, marks ready, merges (squash)
        v
  release-trigger  (caller stub: pull_request_target closed)
    -> uses reusable release-validate.yml
       job validate: full merged-PR forensics; create durable
                     release-run/<version> recovery branch; dispatch release
        |
        | workflow_dispatch (ref = release-run/<version>)
        v
  release          (caller stub: workflow_dispatch)
    -> uses reusable release.yml
       job resolve : re-validate merged PR provenance from the PR number
       job build   : checkout exact release SHA, re-verify version-file diff,
                     install + lint/typecheck/test/build, assemble payload
       job tag     : create/verify the exact stable tag
       job attest  : attestation over the built assets
       job publish : create release, upload assets, verify remote digests,
                     publish, delete recovery branch
       job notify  : opt-in Slack/Discord (skipped unless a webhook secret is set)
```

## Stub-vs-reusable split

`workflow_run` and `pull_request_target` triggers are ignored inside a called
(`workflow_call`) workflow, so those two triggers must live in per-repo caller
stubs. Everything else is a `workflow_call` reusable here. The stubs stay as
close to *trigger + `uses:`* as possible; all logic lives in the reusables.

| Stage | Trigger (must be in stub) | Stub does | Reusable does |
| --- | --- | --- | --- |
| prepare | `workflow_run` (+ `workflow_dispatch` escape hatch) | gates on success/push/default-branch, forwards `head_sha`/`targetSha` as `target-sha`, passes App secret | plan + open/refresh the release PR (all logic) |
| validate | `pull_request_target: [closed]` | gates on merged + base==default-branch + head `release/*`, forwards PR number | full merged-PR forensics, recovery branch, dispatch release (all logic) |
| release | `workflow_dispatch` | forwards PR number, passes notify secrets | resolve + build + tag + attest + publish + notify (all logic) |

Why the prepare stub folds in the `workflow_dispatch` escape hatch: a single
caller file carries both the automatic `workflow_run` path and the manual
`targetSha` path, and its one job forwards
`github.event.workflow_run.head_sha || inputs.targetSha` to the reusable. The
reusable re-confirms the SHA is still the default-branch head, so the stub needs
no staleness logic of its own.

Why validate is its own reusable and not folded into release: the
`pull_request_target` trigger cannot be `workflow_call`, and the validate stage
must create the recovery branch and dispatch release from the *protected*
default-branch context (contents+actions write) - separate from the build/publish
privileges. Keeping them apart preserves least privilege per stage.

## The scripts move here

`release-plan.mjs` and `release-contract.mjs` (plus tests) move into `scripts/`.
The reusable workflows check out **this** repo at a pinned `workflows-ref` into a
side directory, `pnpm install` its `@semantic-release/commit-analyzer` +
`@semantic-release/release-notes-generator` dev deps, and run the scripts with
`--cwd` pointed at the consumer checkout. Consequence: the prepare stage no longer
installs the *consumer's* dependencies at all - the commit analyzer and notes
generator resolve from this repo's `node_modules`, and the script only reads the
consumer's git history and version files. The consumer's package manager is only
exercised in the release **build** job (install + build + test).

Tests are ported to `node:test` + `node:assert` (zero extra dependencies; this
repo previously had no JS toolchain) and run with `pnpm test` (`node --test`).

## Parameterization (the variable surface)

Genuinely per-repo values become `workflow_call` inputs. The load-bearing ones:

- **plugin-name** - marker-string prefix: `<plugin>-release-commit`,
  `<plugin>-release-pr`.
- **package-name / manifest-id** - `package.json` `name` and `manifest.json`
  `id`; default to `plugin-name`.
- **package-manager** - `npm` | `pnpm`. Drives the install command, the cache,
  and the release-file set: npm ships a `package-lock.json` whose version fields
  are synced (4 files); a pnpm version bump does not touch `pnpm-lock.yaml`, so
  pnpm repos have 3 release files. The file set is emitted by
  `release-contract.mjs files --package-manager <pm>` so the workflow shell and
  the script share one source of truth.
- **release-assets** - JSON list, `["main.js","manifest.json"]` or with
  `"styles.css"`. Drives the build payload, the asset manifest, the attestation
  subjects, and the publish upload.
- **default-branch** - default `master`.
- **node-version** - default `24` (podnotes pins `22`).
- **release-bot-app-slug** - the per-repo App slug; the expected bot login is
  `<slug>[bot]`. prepare cross-checks the minted token's slug against it;
  validate and release check `pull.user.login` against it.
- **app-id** (var) + **release-app-private-key** (secret) - mint the App token in
  prepare for PR/commit authorship.
- **workflows-ref / workflows-repository** - the pin + repo for the scripts
  checkout; `workflows-ref` is kept in sync with the `uses: ...@<ref>` pin.
- release build knobs: **build-command**, **verify-commands** (multiline),
  **setup-python** + **python-version** + **docs-requirements** (podnotes docs).
- **slack-webhook / discord-webhook** (optional secrets) - opt-in notify job.

## App token authorship (the key generalization)

PodNotes today authors the release commit and PR as the default
`github-actions[bot]`. The generalized prepare stage mints a per-repo **GitHub App
token** and authors the commit + PR as the app bot (`<slug>[bot]`), so the
forensic author checks bind to a bot identity the maintainer provisions and
controls, not the ambient runner token. The expected bot login is derived from
the `release-bot-app-slug` input; the bot's numeric id (for the
`<id>+<slug>[bot]@users.noreply.github.com` commit-author email) is fetched once
from the API in prepare.

Deliberately **not** moved to the app bot: the GitHub *release* object is still
created by the default `GITHUB_TOKEN` in the publish job, so its author stays
`github-actions[bot]` and the recoverable-draft check keeps that literal. Tags and
the release are created via `GITHUB_TOKEN` (branch protection guards branches, not
tags), so no app token is needed after prepare.

## Security model - what each forensic check defends against

The pipeline assumes the version-file PR is the only trusted path to a release and
that everything after "maintainer clicks merge" is adversarial until proven
otherwise. Layered checks:

- **Standing PR provenance** (validate + resolve): PR author is the app bot, base
  is the default branch, head repo is this repo, branch is `release/<semver>`,
  title is the exact contract string. Defends against a human- or fork-authored PR
  impersonating a release.
- **Exact version-file diff** (validate + build): the PR changes *exactly* the
  release-file set and nothing else; `release-contract.mjs validate-files`
  re-derives that only the version fields moved. Defends against smuggling source
  or lockfile changes into a "version bump".
- **Commit-message contract + parent** (validate): head commit message is the
  exact marker and its single parent is the recorded base. Defends against a
  rewritten or reparented release commit.
- **Squash-parent + tree-sha** (validate): the squash merge commit has one parent
  (the base) and its tree equals the validated head tree. Defends against a merge
  that changed content relative to what was reviewed.
- **Prior-tag ancestry** (validate): the previous version tag exists, has valid
  synchronized metadata, and is an ancestor of the base. Defends against
  version-history forgery and out-of-order releases.
- **Durable recovery branch** `release-run/<version>` (validate/publish): pins the
  exact release SHA so a failed/re-run release recovers to the same commit, and is
  deleted only after a verified publish.
- **Attestation + post-publish verification** (attest/publish):
  `actions/attest-build-provenance` signs the assets; publish runs
  `gh attestation verify` against the exact source digest and then downloads every
  remote asset and re-hashes it. Defends against tampered or swapped release
  assets.

## Migration order

1. **PodNotes first** (npm, the parity reference). Migrate its four release
   workflows to caller stubs pointing at `@v2`; keep its own guarantees. Verify
   against this doc's parity-deviation list.
2. **metaedit, quickadd, notetweet** (pnpm, styles.css). Same stubs with
   `package-manager: pnpm`, `release-assets` including `styles.css`,
   `node-version: 24`.

Each repo needs its App created and installed, and `RELEASE_APP_ID` (var) +
`RELEASE_APP_PRIVATE_KEY` (secret) set before its first release. See the README.

## Dry-run / smoke test before a first real release

`release-prepare.yml` exposes a `dry-run` input: the plan job computes the version
and notes and uploads them as an artifact, and the open-pr job is skipped, so a
consumer can confirm planning works end to end without opening a PR or touching an
App. The README documents driving it via the `workflow_dispatch` escape hatch.
