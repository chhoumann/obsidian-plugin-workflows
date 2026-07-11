import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	DEFAULT_RELEASE_RULES,
	calculateReleasePlan,
	incrementVersion,
	parseReleasePolicy,
} from "./release-plan.mjs";

const tempRoots = [];

function git(cwd, args) {
	return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function writeSynchronizedVersion(root, packageManager, version) {
	let versions = {};
	try {
		versions = JSON.parse(await fs.readFile(path.join(root, "versions.json"), "utf8"));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	versions[version] = "1.0.0";
	const writes = [
		fs.writeFile(
			path.join(root, "package.json"),
			`${JSON.stringify(
				{ name: "podnotes", repository: { url: "https://github.com/chhoumann/PodNotes.git" }, version },
				null,
				2,
			)}\n`,
		),
		fs.writeFile(
			path.join(root, "manifest.json"),
			`${JSON.stringify({ id: "podnotes", minAppVersion: "1.0.0", version }, null, 2)}\n`,
		),
		fs.writeFile(path.join(root, "versions.json"), `${JSON.stringify(versions, null, 2)}\n`),
	];
	if (packageManager === "npm") {
		writes.push(
			fs.writeFile(
				path.join(root, "package-lock.json"),
				`${JSON.stringify(
					{ lockfileVersion: 3, name: "podnotes", packages: { "": { name: "podnotes", version } }, version },
					null,
					2,
				)}\n`,
			),
		);
	}
	await Promise.all(writes);
}

function versionFiles(packageManager) {
	const files = ["package.json", "manifest.json", "versions.json"];
	if (packageManager === "npm") files.push("package-lock.json");
	return files;
}

async function releaseRepository(packageManager) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "opw-release-plan-"));
	tempRoots.push(root);
	git(root, ["init", "--initial-branch=master"]);
	git(root, ["config", "user.name", "PodNotes Test"]);
	git(root, ["config", "user.email", "podnotes@example.com"]);
	await writeSynchronizedVersion(root, packageManager, "2.17.3");
	git(root, ["add", ...versionFiles(packageManager)]);
	git(root, ["commit", "-m", "release(version): Release 2.17.3"]);
	git(root, ["tag", "2.17.3"]);
	return root;
}

function commit(cwd, message) {
	execFileSync("git", ["commit", "--allow-empty", "-m", message], {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_DATE: "2024-03-04T12:00:00Z",
			GIT_COMMITTER_DATE: "2024-03-04T12:00:00Z",
		},
	});
}

function assertMatchObject(actual, expected) {
	for (const [key, value] of Object.entries(expected)) {
		assert.deepEqual(actual[key], value, `mismatch on ${key}`);
	}
}

afterEach(async () => {
	// git commit can leave a detached auto-gc touching .git while rm walks it;
	// retries absorb the resulting transient ENOTEMPTY.
	await Promise.all(
		tempRoots
			.splice(0)
			.map((root) => fs.rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 100 })),
	);
});

describe("release plan", () => {
	it("emits an explicit no-release plan", async () => {
		const root = await releaseRepository("npm");
		commit(root, "docs: clarify installation");
		commit(root, "chore: modernize tooling");
		const plan = await calculateReleasePlan({ cwd: root });
		assertMatchObject(plan, { notes: "", release: false, schemaVersion: 1 });
		assert.equal(plan.baseSha, git(root, ["rev-parse", "HEAD"]));
	});

	const bumpCases = [
		["fix: correct playback", "patch", "2.17.4"],
		["feat: add chapter navigation", "minor", "2.18.0"],
		[
			"feat: replace the public API\n\nBREAKING CHANGE: consumers must use the new API",
			"major",
			"3.0.0",
		],
		["build(deps): update Vite", "patch", "2.17.4"],
	];
	for (const [message, type, version] of bumpCases) {
		it(`plans "${message.split("\n")[0]}" as a ${type} release`, async () => {
			const root = await releaseRepository("npm");
			commit(root, message);
			const plan = await calculateReleasePlan({ cwd: root });
			assertMatchObject(plan, {
				nextVersion: version,
				previousVersion: "2.17.3",
				release: true,
				releaseType: type,
				schemaVersion: 1,
			});
			assert.notEqual(plan.notes.trim(), "");
			assert.ok(plan.notes.includes("(2024-03-04)"));
		});
	}

	it("plans a pnpm repo with no lockfile", async () => {
		const root = await releaseRepository("pnpm");
		commit(root, "feat: add chapter navigation");
		const plan = await calculateReleasePlan({ cwd: root, packageManager: "pnpm" });
		assertMatchObject(plan, { nextVersion: "2.18.0", previousVersion: "2.17.3", release: true });
	});

	it("ignores a release commit after the latest tag", async () => {
		const root = await releaseRepository("npm");
		commit(root, "release(version): Release 2.17.3");
		assertMatchObject(await calculateReleasePlan({ cwd: root }), { release: false });
	});

	it("recomputes an expected release when its recovery tag already targets HEAD", async () => {
		const root = await releaseRepository("npm");
		commit(root, "fix: correct playback");
		await writeSynchronizedVersion(root, "npm", "2.17.4");
		git(root, ["add", ...versionFiles("npm")]);
		commit(root, "release(version): Release 2.17.4");
		git(root, ["tag", "2.17.4"]);
		assertMatchObject(await calculateReleasePlan({ cwd: root, expectedVersion: "2.17.4" }), {
			nextVersion: "2.17.4",
			previousVersion: "2.17.3",
			release: true,
		});
	});

	it("rejects an expected recovery tag that does not target HEAD", async () => {
		const root = await releaseRepository("npm");
		git(root, ["checkout", "--quiet", "-b", "stray-release"]);
		commit(root, "docs: create a divergent tag");
		git(root, ["tag", "2.17.4"]);
		git(root, ["checkout", "--quiet", "master"]);
		commit(root, "fix: correct playback");
		await assert.rejects(
			calculateReleasePlan({ cwd: root, expectedVersion: "2.17.4" }),
			/not HEAD/,
		);
	});

	it("provides deterministic fallback notes", async () => {
		const root = await releaseRepository("npm");
		commit(root, "fix: correct playback");
		const plan = await calculateReleasePlan({ cwd: root, notesGenerator: async () => "" });
		assert.equal(plan.notes, "## 2.17.4\n\nMaintenance release.\n");
	});

	it("increments stable versions and rejects unsupported release types", () => {
		assert.equal(incrementVersion("2.17.3", "patch"), "2.17.4");
		assert.equal(incrementVersion("2.17.3", "minor"), "2.18.0");
		assert.equal(incrementVersion("2.17.3", "major"), "3.0.0");
		assert.throws(() => incrementVersion("2.17.3", "prerelease"), /Unsupported/);
	});

	it("records the default release policy on a no-release plan", async () => {
		const root = await releaseRepository("npm");
		commit(root, "ci: tighten workflow permissions");
		const plan = await calculateReleasePlan({ cwd: root });
		assertMatchObject(plan, {
			release: false,
			releasePolicy: DEFAULT_RELEASE_RULES,
			schemaVersion: 1,
		});
	});

	it("releases a ci commit under a custom policy and records that policy", async () => {
		const root = await releaseRepository("npm");
		commit(root, "ci: tighten workflow permissions");
		const releaseRules = [{ type: "ci", release: "patch" }];
		const plan = await calculateReleasePlan({ cwd: root, releaseRules });
		assertMatchObject(plan, {
			nextVersion: "2.17.4",
			release: true,
			releasePolicy: releaseRules,
			releaseType: "patch",
		});
	});

	it("suppresses a release when a policy rule sets release to false", async () => {
		const root = await releaseRepository("npm");
		commit(root, "fix(deps): bump got");
		const releaseRules = [{ type: "fix", scope: "deps", release: false }];
		const plan = await calculateReleasePlan({ cwd: root, releaseRules });
		assertMatchObject(plan, { release: false, releasePolicy: releaseRules });
	});

	it("rejects invalid release rules passed to calculateReleasePlan", async () => {
		const root = await releaseRepository("npm");
		commit(root, "fix: correct playback");
		await assert.rejects(
			calculateReleasePlan({ cwd: root, releaseRules: [{ release: "patch" }] }),
			/at least one matcher field/,
		);
	});

	it("parses release policies and rejects malformed ones", () => {
		assert.deepEqual(parseReleasePolicy(""), DEFAULT_RELEASE_RULES);
		assert.deepEqual(parseReleasePolicy(undefined), DEFAULT_RELEASE_RULES);
		assert.deepEqual(parseReleasePolicy("[]"), []);
		assert.deepEqual(parseReleasePolicy('[{ "type": "ci", "release": false }]'), [
			{ type: "ci", release: false },
		]);
		assert.deepEqual(parseReleasePolicy('[{ "breaking": true, "release": "major" }]'), [
			{ breaking: true, release: "major" },
		]);
		assert.deepEqual(parseReleasePolicy('[{ "revert": false, "release": "patch" }]'), [
			{ revert: false, release: "patch" },
		]);
		assert.throws(() => parseReleasePolicy("not json"), /must be valid JSON/);
		assert.throws(() => parseReleasePolicy('{ "type": "ci" }'), /must be an array/);
		assert.throws(() => parseReleasePolicy('[{ "type": "ci" }]'), /index 0 must declare a release outcome/);
		assert.throws(
			() => parseReleasePolicy('[{ "type": "ci", "release": "prerelease" }]'),
			/index 0 must set release to false/,
		);
		assert.throws(
			() => parseReleasePolicy('[{ "type": 3, "release": "patch" }]'),
			/index 0 must set type to a non-empty string or boolean/,
		);
		assert.throws(
			() => parseReleasePolicy('[{ "type": "", "release": "patch" }]'),
			/index 0 must set type to a non-empty string or boolean/,
		);
		assert.throws(
			() => parseReleasePolicy('[{ "release": "patch" }]'),
			/index 0 needs at least one matcher field/,
		);
	});
});
