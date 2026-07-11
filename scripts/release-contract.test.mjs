import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	assertReleaseVersion,
	createArtifactManifest,
	materializeVersionFiles,
	resolveReleaseConfig,
	validateCurrentVersionFiles,
	validatePreviousTagHistory,
	validateReleasePr,
	validateVersionFiles,
} from "./release-contract.mjs";

const npmConfig = resolveReleaseConfig({ packageManager: "npm" });
const pnpmConfig = resolveReleaseConfig({ packageManager: "pnpm", assets: ["main.js", "manifest.json", "styles.css"] });
const tempRoots = [];
const BASE_SHA = "a".repeat(40);

async function makeTempRoot(name) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), `opw-${name}-`));
	tempRoots.push(root);
	return root;
}

async function writeJson(filePath, value) {
	await fs.writeFile(filePath, `${JSON.stringify(value, null, "\t")}\n`);
}

async function writeVersionFixture(root, config, version = "2.17.3") {
	await fs.mkdir(root, { recursive: true });
	await writeJson(path.join(root, "package.json"), {
		name: "podnotes",
		scripts: { test: "vitest" },
		version,
	});
	if (config.lockfile) {
		await writeJson(path.join(root, config.lockfile), {
			lockfileVersion: 3,
			name: "podnotes",
			packages: { "": { name: "podnotes", version } },
			version,
		});
	}
	await writeJson(path.join(root, "manifest.json"), {
		id: "podnotes",
		minAppVersion: "1.0.0",
		version,
	});
	await writeJson(path.join(root, "versions.json"), { [version]: "1.0.0" });
}

afterEach(async () => {
	await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { force: true, recursive: true })));
});

describe("release config", () => {
	it("derives four files for npm and three for pnpm", () => {
		assert.deepEqual(resolveReleaseConfig({ packageManager: "npm" }).files, [
			"package.json",
			"package-lock.json",
			"manifest.json",
			"versions.json",
		]);
		assert.deepEqual(resolveReleaseConfig({ packageManager: "pnpm" }).files, [
			"package.json",
			"manifest.json",
			"versions.json",
		]);
	});

	it("rejects unknown managers and invalid asset lists", () => {
		assert.throws(() => resolveReleaseConfig({ packageManager: "yarn" }), /Unsupported package manager/);
		assert.throws(() => resolveReleaseConfig({ assets: ["main.js"] }), /must include main.js and manifest.json/);
		assert.throws(
			() => resolveReleaseConfig({ assets: ["main.js", "manifest.json", "manifest.json"] }),
			/distinct/,
		);
	});
});

for (const config of [npmConfig, pnpmConfig]) {
	describe(`release version contract (${config.packageManager})`, () => {
		it("validates synchronized current version metadata", async () => {
			const root = await makeTempRoot("release-current");
			await writeVersionFixture(root, config);
			assert.deepEqual(validateCurrentVersionFiles(root, config), {
				minAppVersion: "1.0.0",
				version: "2.17.3",
			});

			await writeJson(path.join(root, "versions.json"), { "2.17.2": "0.9.0" });
			assert.throws(() => validateCurrentVersionFiles(root, config), /does not record/);
		});

		it("materializes and validates exactly synchronized version files", async () => {
			const root = await makeTempRoot("release-source");
			const out = await makeTempRoot("release-output");
			await writeVersionFixture(root, config);

			const metadata = materializeVersionFiles({ baseSha: BASE_SHA, config, out, root, version: "2.17.4" });
			assert.equal(metadata.baseSha, BASE_SHA);
			assert.equal(metadata.schemaVersion, 1);
			assert.equal(metadata.version, "2.17.4");
			assert.equal(metadata.files.length, config.files.length);
			assert.ok(metadata.files.every((file) => file.sha256.length === 64 && file.size > 0));
			assert.deepEqual(validateVersionFiles({ baseRoot: root, candidateRoot: out, config, version: "2.17.4" }), {
				version: "2.17.4",
			});

			const packageJson = JSON.parse(await fs.readFile(path.join(out, "package.json"), "utf8"));
			const manifest = JSON.parse(await fs.readFile(path.join(out, "manifest.json"), "utf8"));
			const versions = JSON.parse(await fs.readFile(path.join(out, "versions.json"), "utf8"));
			assert.equal(packageJson.version, "2.17.4");
			assert.equal(manifest.version, "2.17.4");
			assert.equal(versions["2.17.4"], "1.0.0");
			if (config.lockfile) {
				const lock = JSON.parse(await fs.readFile(path.join(out, config.lockfile), "utf8"));
				assert.equal(lock.version, "2.17.4");
				assert.equal(lock.packages[""].version, "2.17.4");
			} else {
				await assert.rejects(fs.access(path.join(out, "pnpm-lock.yaml")));
			}
		});

		it("rejects output reuse and an existing version entry", async () => {
			const root = await makeTempRoot("release-existing");
			const out = await makeTempRoot("release-nonempty");
			await writeVersionFixture(root, config);
			await fs.writeFile(path.join(out, "unexpected"), "x");
			assert.throws(
				() => materializeVersionFiles({ baseSha: BASE_SHA, config, out, root, version: "2.17.4" }),
				/must be empty/,
			);

			const versions = JSON.parse(await fs.readFile(path.join(root, "versions.json"), "utf8"));
			versions["2.17.4"] = "1.0.0";
			await writeJson(path.join(root, "versions.json"), versions);
			const cleanOut = await makeTempRoot("release-clean");
			assert.throws(
				() => materializeVersionFiles({ baseSha: BASE_SHA, config, out: cleanOut, root, version: "2.17.4" }),
				/already contains/,
			);
		});

		it("rejects a symlinked version output directory", async () => {
			const root = await makeTempRoot("release-symlink-source");
			const target = await makeTempRoot("release-symlink-target");
			const parent = await makeTempRoot("release-symlink-parent");
			const output = path.join(parent, "linked-output");
			await writeVersionFixture(root, config);
			await fs.symlink(target, output);
			assert.throws(
				() => materializeVersionFiles({ baseSha: BASE_SHA, config, out: output, root, version: "2.17.4" }),
				/real directory/,
			);
		});

		it("rejects downgrades and unsynchronized version history", async () => {
			const root = await makeTempRoot("release-history");
			await writeVersionFixture(root, config);
			const downgradeOut = await makeTempRoot("release-downgrade");
			assert.throws(
				() => materializeVersionFiles({ baseSha: BASE_SHA, config, out: downgradeOut, root, version: "2.17.2" }),
				/must be newer/,
			);

			await writeJson(path.join(root, "versions.json"), { "2.17.3": "2.0.0" });
			const historyOut = await makeTempRoot("release-bad-history");
			assert.throws(
				() => materializeVersionFiles({ baseSha: BASE_SHA, config, out: historyOut, root, version: "2.17.4" }),
				/must increase/,
			);
		});

		it("rejects extra versions.json mutations", async () => {
			const root = await makeTempRoot("release-version-base");
			const out = await makeTempRoot("release-version-candidate");
			await writeVersionFixture(root, config);
			materializeVersionFiles({ baseSha: BASE_SHA, config, out, root, version: "2.17.4" });
			const versions = JSON.parse(await fs.readFile(path.join(out, "versions.json"), "utf8"));
			versions["1.0.0"] = "0.1.0";
			await writeJson(path.join(out, "versions.json"), versions);
			assert.throws(
				() => validateVersionFiles({ baseRoot: root, candidateRoot: out, config, version: "2.17.4" }),
				/versions.json changed outside/,
			);
		});
	});
}

describe("release version contract (npm-only mutations)", () => {
	const cases = [
		{
			file: "package.json",
			mutate: (value) => {
				value.scripts = { test: "malicious-command" };
			},
			error: /package.json changed outside/,
		},
		{
			file: "package-lock.json",
			mutate: (value) => {
				value.lockfileVersion = 2;
			},
			error: /package-lock.json changed outside/,
		},
		{
			file: "manifest.json",
			mutate: (value) => {
				value.name = "Impostor";
			},
			error: /manifest.json changed outside/,
		},
	];
	for (const { error, file, mutate } of cases) {
		it(`rejects non-version changes in ${file}`, async () => {
			const root = await makeTempRoot("release-base");
			const out = await makeTempRoot("release-candidate");
			await writeVersionFixture(root, npmConfig);
			materializeVersionFiles({ baseSha: BASE_SHA, config: npmConfig, out, root, version: "2.17.4" });
			const value = JSON.parse(await fs.readFile(path.join(out, file), "utf8"));
			mutate(value);
			await writeJson(path.join(out, file), value);
			assert.throws(
				() => validateVersionFiles({ baseRoot: root, candidateRoot: out, config: npmConfig, version: "2.17.4" }),
				error,
			);
		});
	}
});

describe("minAppVersion floor", () => {
	it("rejects a candidate minAppVersion below the base", async () => {
		const root = await makeTempRoot("floor-base");
		const out = await makeTempRoot("floor-candidate");
		await writeVersionFixture(root, npmConfig);
		materializeVersionFiles({ baseSha: BASE_SHA, config: npmConfig, out, root, version: "2.17.4" });
		const manifest = JSON.parse(await fs.readFile(path.join(out, "manifest.json"), "utf8"));
		manifest.minAppVersion = "0.9.0";
		await writeJson(path.join(out, "manifest.json"), manifest);
		assert.throws(
			() => validateVersionFiles({ baseRoot: root, candidateRoot: out, config: npmConfig, version: "2.17.4" }),
			/must not be lower than base/,
		);
	});

	it("rejects a non-semver minAppVersion", async () => {
		const root = await makeTempRoot("floor-shape-base");
		const out = await makeTempRoot("floor-shape-candidate");
		await writeVersionFixture(root, npmConfig);
		materializeVersionFiles({ baseSha: BASE_SHA, config: npmConfig, out, root, version: "2.17.4" });
		const manifest = JSON.parse(await fs.readFile(path.join(out, "manifest.json"), "utf8"));
		manifest.minAppVersion = "1.0";
		await writeJson(path.join(out, "manifest.json"), manifest);
		assert.throws(
			() => validateVersionFiles({ baseRoot: root, candidateRoot: out, config: npmConfig, version: "2.17.4" }),
			/stable semantic version/,
		);
	});
});

describe("pending minAppVersion floor", () => {
	async function writePendingFixture(root) {
		await writeVersionFixture(root, npmConfig);
		const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
		manifest.minAppVersion = "1.1.0";
		await writeJson(path.join(root, "manifest.json"), manifest);
	}

	it("accepts a manifest floor raised ahead of the next release", async () => {
		const root = await makeTempRoot("pending-current");
		await writePendingFixture(root);
		assert.deepEqual(validateCurrentVersionFiles(root, npmConfig), {
			minAppVersion: "1.1.0",
			version: "2.17.3",
		});
	});

	it("materializes the pending floor into the new release entry", async () => {
		const root = await makeTempRoot("pending-source");
		const out = await makeTempRoot("pending-output");
		await writePendingFixture(root);
		materializeVersionFiles({ baseSha: BASE_SHA, config: npmConfig, out, root, version: "2.17.4" });
		const versions = JSON.parse(await fs.readFile(path.join(out, "versions.json"), "utf8"));
		assert.equal(versions["2.17.4"], "1.1.0");
		assert.equal(versions["2.17.3"], "1.0.0");
		assert.deepEqual(
			validateVersionFiles({ baseRoot: root, candidateRoot: out, config: npmConfig, version: "2.17.4" }),
			{ version: "2.17.4" },
		);
	});

	it("rejects a manifest floor below the released record", async () => {
		const root = await makeTempRoot("pending-lowered");
		await writeVersionFixture(root, npmConfig);
		const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
		manifest.minAppVersion = "0.9.0";
		await writeJson(path.join(root, "manifest.json"), manifest);
		assert.throws(() => validateCurrentVersionFiles(root, npmConfig), /must increase/);
		const out = await makeTempRoot("pending-lowered-out");
		assert.throws(
			() => materializeVersionFiles({ baseSha: BASE_SHA, config: npmConfig, out, root, version: "2.17.4" }),
			/must increase/,
		);
	});
});

describe("previous tag history", () => {
	async function writeTagFixture(root, { minAppVersion = "1.0.0", versions } = {}) {
		await fs.mkdir(root, { recursive: true });
		await writeJson(path.join(root, "manifest.json"), {
			id: "podnotes",
			minAppVersion,
			version: "2.17.3",
		});
		await writeJson(path.join(root, "versions.json"), versions ?? { "2.17.3": minAppVersion });
	}

	it("accepts an unchanged history and a non-decreasing floor", async () => {
		const previous = await makeTempRoot("prev-ok");
		const base = await makeTempRoot("base-ok");
		await writeTagFixture(previous, { minAppVersion: "1.0.0" });
		await writeTagFixture(base, { minAppVersion: "1.0.0" });
		assert.deepEqual(
			validatePreviousTagHistory({ previousRoot: previous, baseRoot: base, config: npmConfig }),
			{ baseMinAppVersion: "1.0.0", previousMinAppVersion: "1.0.0" },
		);
	});

	it("rejects a base minAppVersion below the previous tag", async () => {
		const previous = await makeTempRoot("prev-floor");
		const base = await makeTempRoot("base-floor");
		await writeTagFixture(previous, { minAppVersion: "1.5.0", versions: { "2.17.3": "1.0.0" } });
		await writeTagFixture(base, { minAppVersion: "1.4.0", versions: { "2.17.3": "1.0.0" } });
		assert.throws(
			() => validatePreviousTagHistory({ previousRoot: previous, baseRoot: base, config: npmConfig }),
			/must not be lower than previous release/,
		);
	});

	it("rejects rewritten version history", async () => {
		const previous = await makeTempRoot("prev-history");
		const base = await makeTempRoot("base-history");
		await writeTagFixture(previous, { versions: { "2.17.3": "1.0.0" } });
		await writeTagFixture(base, { versions: { "2.17.3": "1.0.0", "2.16.0": "0.9.0" } });
		assert.throws(
			() => validatePreviousTagHistory({ previousRoot: previous, baseRoot: base, config: npmConfig }),
			/history diverges from the previous release tag/,
		);
	});
});

describe("release version helpers", () => {
	it("accepts stable semantic versions only", () => {
		assert.equal(assertReleaseVersion("2.17.4"), "2.17.4");
		for (const value of ["v2.17.4", "2.17", "02.17.4", "2.17.4-beta.1", "../2.17.4"]) {
			assert.throws(() => assertReleaseVersion(value), /Invalid release version/);
		}
	});
});

describe("release PR provenance", () => {
	const validInput = {
		baseRef: "master",
		branch: "release/2.17.4",
		changedFiles: ["versions.json", "package.json", "manifest.json", "package-lock.json"],
		headRepository: "chhoumann/PodNotes",
		repository: "chhoumann/PodNotes",
		title: "release(version): Release 2.17.4",
		version: "2.17.4",
	};

	it("accepts an exact same-repository release PR", () => {
		assert.deepEqual(validateReleasePr(validInput, npmConfig), { version: "2.17.4" });
	});

	it("honours a non-default branch name", () => {
		assert.deepEqual(
			validateReleasePr({ ...validInput, baseRef: "main", defaultBranch: "main" }, npmConfig),
			{ version: "2.17.4" },
		);
	});

	const rejects = [
		[{ ...validInput, branch: "feature/release" }, /branch\/version/],
		[{ ...validInput, title: "Release 2.17.4" }, /title\/version/],
		[{ ...validInput, headRepository: "fork/PodNotes" }, /this repository/],
		[{ ...validInput, changedFiles: [...validInput.changedFiles, "src/main.ts"] }, /exactly/],
	];
	for (const [input, error] of rejects) {
		it(`rejects invalid release PR provenance (${error.source})`, () => {
			assert.throws(() => validateReleasePr(input, npmConfig), error);
		});
	}
});

describe("release artifact manifest", () => {
	it("hashes exactly the declared regular release assets", async () => {
		const root = await makeTempRoot("release-assets");
		await fs.writeFile(path.join(root, "main.js"), "bundle");
		await fs.writeFile(path.join(root, "manifest.json"), "manifest");
		await fs.writeFile(path.join(root, "styles.css"), "styles");
		const output = path.join(root, "metadata.json");
		const manifest = createArtifactManifest({
			artifacts: ["main.js", "manifest.json", "styles.css"],
			config: pnpmConfig,
			output,
			root,
		});
		assert.equal(manifest.artifacts.length, 3);
		assert.deepEqual(JSON.parse(await fs.readFile(output, "utf8")), manifest);
	});

	it("rejects extra assets and symlinks", async () => {
		const root = await makeTempRoot("release-unsafe-assets");
		await fs.writeFile(path.join(root, "real-main.js"), "bundle");
		await fs.symlink(path.join(root, "real-main.js"), path.join(root, "main.js"));
		await fs.writeFile(path.join(root, "manifest.json"), "manifest");
		assert.throws(
			() => createArtifactManifest({ artifacts: ["main.js", "manifest.json"], config: npmConfig, root }),
			/regular file/,
		);
		assert.throws(
			() =>
				createArtifactManifest({
					artifacts: ["main.js", "manifest.json", "extra.js"],
					config: npmConfig,
					root,
				}),
			/exactly/,
		);
	});
});
