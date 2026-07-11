# Templates

Copy-in files for an Obsidian plugin repo. Unlike the workflows in
`.github/workflows/`, these are **not** reusable via `workflow_call` - you copy
them into your repo and adjust. They are versioned here so the three plugin repos
share one canonical source instead of drifting.

## `version-bump.mjs`

Syncs `manifest.json` and `versions.json` with the released version. Place it at
the repo root.

- Reads the target version from `process.argv[2]` (passed by
  `@semantic-release/exec`), falling back to `npm_package_version` for manual
  `npm version` / `pnpm version` runs.
- Writes `manifest.version = <target>` and records
  `versions[<target>] = manifest.minAppVersion`, so Obsidian can select the
  newest plugin build compatible with a given app version.
- Tab-indented output matches Obsidian's own manifest formatting, keeping diffs
  clean.

Referenced from the release config as
`node version-bump.mjs ${nextRelease.version}`.

## `semantic-release.jsonc`

The canonical semantic-release plugin chain. It is a **template**, not a
workflow: the actual release *pipeline* stays per-repo (quickadd uses app-token +
provenance, podnotes uses a machine-PR pipeline), but the plugin chain that
turns Conventional Commits into an Obsidian release is shared.

To adopt: strip the comments and paste the object into the `"release"` key of
`package.json` (or save as `.releaserc.json`). Key choices are documented inline;
the load-bearing ones:

- `tagFormat: "${version}"` - bare version tag (`0.1.2`), which is what
  Obsidian's community-plugin releaser expects (no `v` prefix).
- `commit-analyzer` `chore -> patch` rule - housekeeping/dependency commits still
  cut a patch release.
- `@semantic-release/npm` with `npmPublish: false` - distributed as GitHub
  release assets, never to the npm registry.
- `@semantic-release/exec` `prepareCmd` - runs `version-bump.mjs`.
- `@semantic-release/git` assets - commits `package.json`, the lockfile,
  `manifest.json`, `versions.json` back with a `release(version): ...` message.
  Set the lockfile to `pnpm-lock.yaml` or `package-lock.json` to match your repo.
- `@semantic-release/github` assets - uploads `main.js`, `manifest.json`, and
  `styles.css` to the release. Drop `styles.css` if the plugin ships no
  stylesheet.

## `dependabot.yml`

Grouped weekly updates for GitHub Actions and npm dependencies. Place at
`.github/dependabot.yml`. Commit prefixes (`ci` for Actions, `build` for package
deps) match the Conventional Commit types the release toolkit expects. Add extra
`package-ecosystem` entries (e.g. a `docs/` subproject) as your repo needs.

## `caller-workflows/`

Minimal stubs that consume the reusable workflows in this repo. Copy each into
your repo's `.github/workflows/` and pin `@v1`/`@v2` (or a commit SHA). They
encode the triggers that CANNOT live in the reusable workflow.

CI and quality:

- `ci.yml` - `push` + `pull_request` with **no** path filters, plus
  `workflow_dispatch`.
- `codeql.yml` - carries the weekly `schedule:` cron (a called workflow's own
  `schedule` never fires).
- `dependency-review.yml` - `pull_request`, no path filters.
- `pr-title.yml` - `pull_request_target` (required for fork-PR title access).

Release pipeline (worked for podnotes; see the repo root README's
[Release pipeline](../README.md#release-pipeline) section):

- `release-prepare.yml` - `workflow_run` (CI completed) that opens/refreshes the
  standing release PR, plus a `workflow_dispatch` escape hatch for manual and
  dry-run planning.
- `release-trigger.yml` - `pull_request_target: [closed]` that runs the merged-PR
  forensics and dispatches the release.
- `release.yml` - `workflow_dispatch`, dispatched by the trigger stub, that builds,
  attests, and publishes.

See the repo root `README.md` for the full input reference for each reusable
workflow.
