import { readFileSync, writeFileSync } from "fs";

// Keeps manifest.json and versions.json in sync with the released version.
//
// semantic-release passes the version explicitly via @semantic-release/exec
// (`node version-bump.mjs ${nextRelease.version}`). The npm_package_version
// fallback covers any manual `npm version` / `pnpm version` invocation.
const targetVersion = process.argv[2] ?? process.env.npm_package_version;

if (!targetVersion) {
    throw new Error(
        "version-bump: no target version (pass as argv[2] or set npm_package_version)",
    );
}

// Read minAppVersion from manifest.json and set version to the target version.
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t"));

// Record targetVersion -> minAppVersion in versions.json so Obsidian can pick
// the newest plugin build compatible with a given app version.
const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t"));
