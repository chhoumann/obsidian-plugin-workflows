import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

// Executes the real `open-pr` github-script from release-prepare.yml against a
// mocked GitHub API, so the standing-release-PR lifecycle (create, refresh,
// supersede) is tested as shipped instead of as a reimplementation.

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const workflowPath = fileURLToPath(
	new URL("../.github/workflows/release-prepare.yml", import.meta.url),
);
const nodeRequire = createRequire(import.meta.url);

const OWNER = "chhoumann";
const REPO = "notetweet_obsidian";
const PLUGIN = "notetweet";
const APP_SLUG = "notetweet-release-bot";
const BOT_LOGIN = `${APP_SLUG}[bot]`;
const BOT_ID = 111;
const BOT_EMAIL = `${BOT_ID}+${BOT_LOGIN}@users.noreply.github.com`;
const DEFAULT_BRANCH = "master";
const RELEASE_FILES = ["package.json", "package-lock.json", "manifest.json", "versions.json"];
const MASTER_SHA = "a".repeat(40);
const STALE_BASE_SHA = "d".repeat(40);
const STALE_HEAD_SHA = "c".repeat(40);

const originalCwd = process.cwd();
const tempRoots = [];

afterEach(async () => {
	process.chdir(originalCwd);
	await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function loadOpenPrScript() {
	const lines = (await fs.readFile(workflowPath, "utf8")).split("\n");
	const stepIndex = lines.findIndex((line) =>
		line.includes("- name: Create or refresh release branch and PR"));
	assert.notEqual(stepIndex, -1, "open-pr step not found in release-prepare.yml");
	const scriptIndex = lines.findIndex((line, index) =>
		index > stepIndex && /^\s*script: \|\s*$/.test(line));
	assert.notEqual(scriptIndex, -1, "script block not found after the open-pr step");
	let indent = null;
	const body = [];
	for (const line of lines.slice(scriptIndex + 1)) {
		if (!line.trim()) {
			body.push("");
			continue;
		}
		const leading = line.length - line.trimStart().length;
		if (indent === null) indent = leading;
		if (leading < indent) break;
		body.push(line.slice(indent));
	}
	assert.ok(body.length > 0, "script block is empty");
	return body.join("\n");
}

async function writeArtifact(version, baseSha) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "opw-open-pr-"));
	tempRoots.push(root);
	const dir = path.join(root, "release-version-files");
	await fs.mkdir(dir, { recursive: true });
	const entries = [];
	for (const name of RELEASE_FILES) {
		const contents = Buffer.from(`${name} for ${version}\n`);
		await fs.writeFile(path.join(dir, name), contents);
		entries.push({
			name,
			sha256: crypto.createHash("sha256").update(contents).digest("hex"),
			size: contents.byteLength,
		});
	}
	await fs.writeFile(
		path.join(dir, "release-version-files.json"),
		JSON.stringify({ schemaVersion: 1, version, baseSha, files: entries }),
	);
	return root;
}

function generatedCommit(version, baseSha) {
	return {
		parents: [{ sha: baseSha }],
		commit: {
			message: `release(version): Release ${version}\n\n` +
				`${PLUGIN}-release-commit schema=1 version=${version} base=${baseSha}`,
			author: { email: BOT_EMAIL },
		},
		files: RELEASE_FILES.map((filename) => ({ filename, status: "modified" })),
	};
}

function botPull(number, version, headSha, baseSha, overrides = {}) {
	return {
		number,
		state: "open",
		draft: true,
		title: `release(version): Release ${version}`,
		body: `<!-- ${PLUGIN}-release-pr schema=1 version=${version} base=${baseSha} -->`,
		user: { login: BOT_LOGIN },
		base: { ref: DEFAULT_BRANCH },
		head: { ref: `release/${version}`, sha: headSha, repo: { full_name: `${OWNER}/${REPO}` } },
		...overrides,
	};
}

function createState({ branches = {}, pulls = [], commitDetails = {} } = {}) {
	return {
		branches: new Map(Object.entries(branches)),
		commitDetails: new Map(Object.entries(commitDetails)),
		pulls,
		comments: [],
		warnings: [],
		notices: [],
		log: [],
		nextPullNumber: Math.max(52, ...pulls.map((pull) => pull.number)),
		sequence: 0,
	};
}

function createGithub(state) {
	const stripHeads = (ref) => ref.replace(/^(refs\/)?heads\//, "");
	const rest = {
		users: {
			getByUsername: async ({ username }) => {
				assert.equal(username, BOT_LOGIN);
				return { data: { id: BOT_ID } };
			},
		},
		git: {
			getRef: async ({ ref }) => {
				const sha = state.branches.get(stripHeads(ref));
				if (!sha) {
					const error = new Error(`Not found: ${ref}`);
					error.status = 404;
					throw error;
				}
				return { data: { object: { sha } } };
			},
			listMatchingRefs: async ({ ref }) => {
				const prefix = stripHeads(ref);
				const matches = [...state.branches.keys()]
					.filter((name) => name === prefix || name.startsWith(`${prefix}/`))
					.map((name) => ({ ref: `refs/heads/${name}` }));
				return { data: matches };
			},
			getCommit: async () => ({ data: { tree: { sha: "base-tree" } } }),
			createBlob: async () => ({ data: { sha: `blob-${(state.sequence += 1)}` } }),
			createTree: async () => ({ data: { sha: `tree-${(state.sequence += 1)}` } }),
			createCommit: async () => ({ data: { sha: `${(state.sequence += 1)}`.padStart(40, "e") } }),
			createRef: async ({ ref, sha }) => {
				state.branches.set(stripHeads(ref), sha);
				state.log.push(["createRef", stripHeads(ref)]);
				return { data: {} };
			},
			updateRef: async ({ ref, sha }) => {
				state.branches.set(stripHeads(ref), sha);
				state.log.push(["updateRef", stripHeads(ref)]);
				return { data: {} };
			},
			deleteRef: async ({ ref }) => {
				state.branches.delete(stripHeads(ref));
				state.log.push(["deleteRef", stripHeads(ref)]);
				return { data: {} };
			},
		},
		repos: {
			getCommit: async ({ ref }) => {
				const details = state.commitDetails.get(ref);
				assert.ok(details, `no commit details fixture for ${ref}`);
				return { data: details };
			},
		},
		pulls: {
			list: async (params) => {
				let pulls = state.pulls.filter((pull) => pull.state === params.state);
				if (params.head) pulls = pulls.filter((pull) => `${OWNER}:${pull.head.ref}` === params.head);
				if (params.base) pulls = pulls.filter((pull) => pull.base.ref === params.base);
				return { data: pulls };
			},
			get: async ({ pull_number: pullNumber }) => (
				{ data: state.pulls.find((pull) => pull.number === pullNumber) }
			),
			update: async ({ pull_number: pullNumber, ...updates }) => {
				const pull = state.pulls.find((candidate) => candidate.number === pullNumber);
				assert.ok(pull, `no pull #${pullNumber}`);
				if (updates.base) pull.base = { ref: updates.base };
				for (const key of ["title", "body", "state"]) {
					if (updates[key] !== undefined) pull[key] = updates[key];
				}
				state.log.push(["pulls.update", pullNumber]);
				return { data: pull };
			},
			create: async ({ head, title, body }) => {
				const number = (state.nextPullNumber += 1);
				const pull = botPull(number, "", state.branches.get(head), "", {
					title,
					body,
					head: { ref: head, sha: state.branches.get(head), repo: { full_name: `${OWNER}/${REPO}` } },
					html_url: `https://example.test/pull/${number}`,
				});
				state.pulls.push(pull);
				state.log.push(["pulls.create", number, head]);
				return { data: pull };
			},
		},
		issues: {
			createComment: async ({ issue_number: issueNumber, body }) => {
				state.comments.push({ number: issueNumber, body });
				return { data: {} };
			},
		},
	};
	return {
		rest,
		paginate: async (fn, params) => (await fn(params)).data,
		graphql: async () => {
			state.log.push(["graphql"]);
			return {};
		},
	};
}

async function runOpenPrScript(state, { version, baseSha = MASTER_SHA } = {}) {
	const script = await loadOpenPrScript();
	const root = await writeArtifact(version, baseSha);
	process.chdir(root);
	const run = new AsyncFunction("github", "context", "core", "require", "process", script);
	await run(
		createGithub(state),
		{ repo: { owner: OWNER, repo: REPO } },
		{
			notice: (message) => state.notices.push(message),
			warning: (message) => state.warnings.push(message),
			setOutput: () => {},
		},
		nodeRequire,
		{
			env: {
				BASE_SHA: baseSha,
				VERSION: version,
				RELEASE_FILES: JSON.stringify(RELEASE_FILES),
				PLUGIN_NAME: PLUGIN,
				DEFAULT_BRANCH,
				APP_SLUG,
				EXPECTED_APP_SLUG: APP_SLUG,
			},
		},
	);
}

describe("release-prepare open-pr script", () => {
	it("opens a fresh release PR when none exists", async () => {
		const state = createState({ branches: { [DEFAULT_BRANCH]: MASTER_SHA } });

		await runOpenPrScript(state, { version: "0.7.0" });

		assert.equal(state.pulls.length, 1);
		assert.equal(state.pulls[0].head.ref, "release/0.7.0");
		assert.equal(state.pulls[0].state, "open");
		assert.ok(state.branches.has("release/0.7.0"));
		assert.deepEqual(state.comments, []);
	});

	it("refreshes the standing PR in place when the version is unchanged", async () => {
		const headSha = "f".repeat(40);
		const state = createState({
			branches: { [DEFAULT_BRANCH]: MASTER_SHA, "release/0.7.0": headSha },
			pulls: [botPull(50, "0.7.0", headSha, STALE_BASE_SHA)],
			commitDetails: { [headSha]: generatedCommit("0.7.0", STALE_BASE_SHA) },
		});

		await runOpenPrScript(state, { version: "0.7.0" });

		assert.equal(state.pulls.length, 1);
		assert.equal(state.pulls[0].number, 50);
		assert.equal(state.pulls[0].state, "open");
		assert.ok(state.log.some(([action, ref]) => action === "updateRef" && ref === "release/0.7.0"));
		assert.ok(!state.log.some(([action]) => action === "pulls.create"));
		assert.deepEqual(state.comments, []);
	});

	it("closes the old-version release PR the new plan supersedes", async () => {
		const state = createState({
			branches: { [DEFAULT_BRANCH]: MASTER_SHA, "release/0.6.7": STALE_HEAD_SHA },
			pulls: [botPull(52, "0.6.7", STALE_HEAD_SHA, STALE_BASE_SHA)],
			commitDetails: { [STALE_HEAD_SHA]: generatedCommit("0.6.7", STALE_BASE_SHA) },
		});

		await runOpenPrScript(state, { version: "0.7.0" });

		const fresh = state.pulls.find((pull) => pull.head.ref === "release/0.7.0");
		const stale = state.pulls.find((pull) => pull.number === 52);
		assert.ok(fresh, "new release PR was not created");
		assert.equal(fresh.state, "open");
		assert.equal(stale.state, "closed");
		assert.equal(state.comments.length, 1);
		assert.equal(state.comments[0].number, 52);
		assert.match(state.comments[0].body, new RegExp(`Superseded by release PR #${fresh.number}`));
		assert.match(state.comments[0].body, /version 0\.7\.0, not 0\.6\.7/);
		assert.ok(!state.branches.has("release/0.6.7"), "superseded branch was not deleted");
		assert.ok(state.branches.has("release/0.7.0"));
	});

	it("leaves non-generated PRs in the release namespace open", async () => {
		const state = createState({
			branches: { [DEFAULT_BRANCH]: MASTER_SHA, "release/0.6.7": STALE_HEAD_SHA },
			pulls: [botPull(52, "0.6.7", STALE_HEAD_SHA, STALE_BASE_SHA, { user: { login: "chhoumann" } })],
		});

		await runOpenPrScript(state, { version: "0.7.0" });

		const stale = state.pulls.find((pull) => pull.number === 52);
		assert.equal(stale.state, "open");
		assert.ok(state.branches.has("release/0.6.7"));
		assert.deepEqual(state.comments, []);
		assert.equal(state.warnings.length, 1);
		assert.match(state.warnings[0], /Leaving PR #52 open/);
	});

	it("rejects superseding a bot PR whose branch commit is not machine-generated", async () => {
		const tampered = generatedCommit("0.6.7", STALE_BASE_SHA);
		tampered.commit.message = "release(version): Release 0.6.7\n\ntampered";
		const state = createState({
			branches: { [DEFAULT_BRANCH]: MASTER_SHA, "release/0.6.7": STALE_HEAD_SHA },
			pulls: [botPull(52, "0.6.7", STALE_HEAD_SHA, STALE_BASE_SHA)],
			commitDetails: { [STALE_HEAD_SHA]: tampered },
		});

		await assert.rejects(
			runOpenPrScript(state, { version: "0.7.0" }),
			/Refusing to supersede PR #52/,
		);

		const stale = state.pulls.find((pull) => pull.number === 52);
		assert.equal(stale.state, "open");
		assert.ok(state.branches.has("release/0.6.7"));
		assert.ok(
			state.pulls.some((pull) => pull.head.ref === "release/0.7.0" && pull.state === "open"),
			"the new release PR should stand even when supersede fails loudly",
		);
	});
});
