import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

// The version files and release assets are package-manager dependent:
// - npm ships a package-lock.json whose version fields must move with the
//   release, so an npm repo synchronizes four files.
// - a pnpm version bump never touches pnpm-lock.yaml (it records no root
//   version), so a pnpm repo synchronizes three files and no lockfile.
// release-assets vary independently (some plugins ship styles.css), so they are
// passed in rather than derived.

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DEFAULT_ASSETS = ["main.js", "manifest.json"];

/**
 * @param {{ packageManager?: string; assets?: string[] }} [input]
 * @returns {{ packageManager: "npm" | "pnpm"; lockfile: string | null; files: string[]; assets: string[] }}
 */
export function resolveReleaseConfig(input = {}) {
	const packageManager = input.packageManager ?? "npm";
	let lockfile;
	if (packageManager === "npm") {
		lockfile = "package-lock.json";
	} else if (packageManager === "pnpm") {
		lockfile = null;
	} else {
		throw new Error(`Unsupported package manager: ${packageManager}`);
	}
	const files = ["package.json"];
	if (lockfile) files.push(lockfile);
	files.push("manifest.json", "versions.json");

	const assets = input.assets ?? DEFAULT_ASSETS;
	if (
		!Array.isArray(assets) ||
		assets.length === 0 ||
		!assets.every((name) => typeof name === "string" && name.length > 0) ||
		new Set(assets).size !== assets.length
	) {
		throw new Error("Release assets must be a non-empty list of distinct file names.");
	}
	if (!assets.includes("main.js") || !assets.includes("manifest.json")) {
		throw new Error("Release assets must include main.js and manifest.json.");
	}
	return { assets, files, lockfile, packageManager };
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is Record<string, unknown>}
 */
function assertRecord(value, label) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be a JSON object.`);
	}
}

/** @param {unknown} value */
export function assertReleaseVersion(value) {
	if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) {
		throw new Error(`Invalid release version: ${String(value)}`);
	}
	return value;
}

/**
 * @param {string} root
 * @param {string} fileName
 * @param {ReturnType<typeof resolveReleaseConfig>} config
 */
function safeFilePath(root, fileName, config) {
	if (!config.files.includes(fileName) && !config.assets.includes(fileName)) {
		throw new Error(`Unsupported release file: ${fileName}`);
	}
	const resolvedRoot = path.resolve(root);
	const resolvedFile = path.resolve(resolvedRoot, fileName);
	if (path.dirname(resolvedFile) !== resolvedRoot) {
		throw new Error(`Release file escapes its root: ${fileName}`);
	}
	return resolvedFile;
}

/** @param {string} filePath */
function readRegularFile(filePath) {
	const stat = fs.lstatSync(filePath);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error(`Release input must be a regular file: ${filePath}`);
	}
	return fs.readFileSync(filePath);
}

/**
 * @param {string} root
 * @param {string} fileName
 * @param {ReturnType<typeof resolveReleaseConfig>} config
 */
function readJson(root, fileName, config) {
	const filePath = safeFilePath(root, fileName, config);
	const value = /** @type {unknown} */ (JSON.parse(readRegularFile(filePath).toString("utf8")));
	assertRecord(value, fileName);
	return value;
}

/**
 * @param {string} filePath
 * @param {Record<string, unknown>} value
 */
function writeJson(filePath, value) {
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, "\t")}\n`, {
		encoding: "utf8",
		flag: "wx",
	});
}

/** @param {Buffer} contents */
function fileMetadata(contents) {
	return {
		sha256: crypto.createHash("sha256").update(contents).digest("hex"),
		size: contents.byteLength,
	};
}

/**
 * @param {Record<string, unknown>} packageLock
 * @param {string} label
 */
function lockRootPackage(packageLock, label) {
	assertRecord(packageLock.packages, `${label}.packages`);
	const rootPackage = packageLock.packages[""];
	assertRecord(rootPackage, `${label}.packages[""]`);
	return rootPackage;
}

/**
 * Reads and asserts the synchronized version across every versioned file for the
 * configured package manager (package.json + manifest.json always; the npm
 * lockfile's top-level and root-package versions when present).
 * @param {Record<string, unknown> | null} packageLock
 * @param {Record<string, unknown>} packageJson
 * @param {Record<string, unknown>} manifest
 * @param {ReturnType<typeof resolveReleaseConfig>} config
 * @param {string} label
 * @returns {string}
 */
function assertSynchronizedVersion(packageJson, packageLock, manifest, config, label) {
	const versions = [packageJson.version, manifest.version];
	if (config.lockfile) {
		if (!packageLock) throw new Error(`${label} is missing its lockfile.`);
		versions.push(packageLock.version, lockRootPackage(packageLock, label).version);
	}
	if (!versions.every((version) => typeof version === "string" && version === versions[0])) {
		throw new Error(`${label} version fields are not synchronized.`);
	}
	return assertReleaseVersion(versions[0]);
}

/** @param {string} left @param {string} right */
function compareVersions(left, right) {
	const leftParts = assertReleaseVersion(left).split(".").map(Number);
	const rightParts = assertReleaseVersion(right).split(".").map(Number);
	for (let index = 0; index < 3; index += 1) {
		if (leftParts[index] !== rightParts[index]) {
			return leftParts[index] - rightParts[index];
		}
	}
	return 0;
}

/**
 * @param {string} root
 * @param {ReturnType<typeof resolveReleaseConfig>} config
 */
export function validateCurrentVersionFiles(root, config) {
	const packageJson = readJson(root, "package.json", config);
	const manifest = readJson(root, "manifest.json", config);
	const versions = readJson(root, "versions.json", config);
	const packageLock = config.lockfile ? readJson(root, config.lockfile, config) : null;
	const version = assertSynchronizedVersion(packageJson, packageLock, manifest, config, "current");
	if (typeof manifest.minAppVersion !== "string" || !manifest.minAppVersion) {
		throw new Error("manifest.json minAppVersion must be a non-empty string.");
	}
	if (versions[version] !== manifest.minAppVersion) {
		throw new Error("versions.json does not record the current manifest version.");
	}
	return { minAppVersion: manifest.minAppVersion, version };
}

/**
 * @param {{ root: string; out: string; version: string; baseSha: string; config: ReturnType<typeof resolveReleaseConfig> }} options
 */
export function materializeVersionFiles(options) {
	const config = options.config;
	const version = assertReleaseVersion(options.version);
	if (!/^[0-9a-f]{40}$/i.test(options.baseSha)) {
		throw new Error(`Invalid base SHA: ${options.baseSha}`);
	}

	const outputRoot = path.resolve(options.out);
	fs.mkdirSync(outputRoot, { recursive: true });
	const outputStat = fs.lstatSync(outputRoot);
	if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
		throw new Error(`Release output must be a real directory: ${outputRoot}`);
	}
	if (fs.readdirSync(outputRoot).length > 0) {
		throw new Error(`Release output directory must be empty: ${outputRoot}`);
	}

	const packageJson = structuredClone(readJson(options.root, "package.json", config));
	const manifest = structuredClone(readJson(options.root, "manifest.json", config));
	const versions = structuredClone(readJson(options.root, "versions.json", config));
	const packageLock = config.lockfile
		? structuredClone(readJson(options.root, config.lockfile, config))
		: null;
	const currentVersion = assertSynchronizedVersion(
		packageJson,
		packageLock,
		manifest,
		config,
		"source",
	);
	if (compareVersions(version, currentVersion) <= 0) {
		throw new Error(`Release version ${version} must be newer than ${currentVersion}.`);
	}
	if (versions[currentVersion] !== manifest.minAppVersion) {
		throw new Error(
			"versions.json version history is not synchronized with the current manifest.",
		);
	}
	if (Object.prototype.hasOwnProperty.call(versions, version)) {
		throw new Error(`versions.json already contains ${version}.`);
	}
	if (typeof manifest.minAppVersion !== "string" || !manifest.minAppVersion) {
		throw new Error("manifest.json minAppVersion must be a non-empty string.");
	}

	packageJson.version = version;
	manifest.version = version;
	versions[version] = manifest.minAppVersion;
	if (packageLock) {
		packageLock.version = version;
		lockRootPackage(packageLock, "package-lock.json").version = version;
	}

	const values = new Map([
		["package.json", packageJson],
		["manifest.json", manifest],
		["versions.json", versions],
	]);
	if (config.lockfile && packageLock) values.set(config.lockfile, packageLock);
	const files = [];
	for (const fileName of config.files) {
		const outputPath = safeFilePath(outputRoot, fileName, config);
		const value = values.get(fileName);
		if (!value) throw new Error(`Missing materialized value for ${fileName}.`);
		writeJson(outputPath, value);
		const contents = readRegularFile(outputPath);
		files.push({ name: fileName, ...fileMetadata(contents) });
	}

	const metadata = {
		baseSha: options.baseSha.toLowerCase(),
		files,
		schemaVersion: 1,
		version,
	};
	writeJson(path.join(outputRoot, "release-version-files.json"), metadata);
	return metadata;
}

/**
 * @param {Record<string, unknown>} candidate
 * @param {Record<string, unknown>} baseline
 * @param {string} field
 */
function equalExceptField(candidate, baseline, field) {
	const normalized = structuredClone(candidate);
	normalized[field] = baseline[field];
	return isDeepStrictEqual(normalized, baseline);
}

/**
 * @param {{ baseRoot: string; candidateRoot: string; version: string; config: ReturnType<typeof resolveReleaseConfig> }} options
 */
export function validateVersionFiles(options) {
	const config = options.config;
	const version = assertReleaseVersion(options.version);
	const basePackage = readJson(options.baseRoot, "package.json", config);
	const nextPackage = readJson(options.candidateRoot, "package.json", config);
	const baseManifest = readJson(options.baseRoot, "manifest.json", config);
	const nextManifest = readJson(options.candidateRoot, "manifest.json", config);
	const baseVersions = readJson(options.baseRoot, "versions.json", config);
	const nextVersions = readJson(options.candidateRoot, "versions.json", config);
	const baseLock = config.lockfile ? readJson(options.baseRoot, config.lockfile, config) : null;
	const nextLock = config.lockfile
		? readJson(options.candidateRoot, config.lockfile, config)
		: null;

	const baseVersion = assertSynchronizedVersion(basePackage, baseLock, baseManifest, config, "base");
	assertSynchronizedVersion(nextPackage, nextLock, nextManifest, config, "candidate");
	if (compareVersions(version, baseVersion) <= 0) {
		throw new Error(`Release version ${version} must be newer than ${baseVersion}.`);
	}
	if (baseVersions[baseVersion] !== baseManifest.minAppVersion) {
		throw new Error("Base versions.json is not synchronized with its manifest.");
	}
	if (nextPackage.version !== version) {
		throw new Error(`Candidate version is ${String(nextPackage.version)}, expected ${version}.`);
	}
	if (!equalExceptField(nextPackage, basePackage, "version")) {
		throw new Error("package.json changed outside its version field.");
	}
	if (config.lockfile && baseLock && nextLock) {
		const normalizedLock = structuredClone(nextLock);
		normalizedLock.version = baseLock.version;
		lockRootPackage(normalizedLock, "candidate package-lock.json").version = lockRootPackage(
			baseLock,
			"base package-lock.json",
		).version;
		if (!isDeepStrictEqual(normalizedLock, baseLock)) {
			throw new Error("package-lock.json changed outside its version fields.");
		}
	}
	if (!equalExceptField(nextManifest, baseManifest, "version")) {
		throw new Error("manifest.json changed outside its version field.");
	}
	if (Object.prototype.hasOwnProperty.call(baseVersions, version)) {
		throw new Error(`Base versions.json already contains ${version}.`);
	}
	if (nextVersions[version] !== nextManifest.minAppVersion) {
		throw new Error(`versions.json does not map ${version} to manifest minAppVersion.`);
	}
	const normalizedVersions = structuredClone(nextVersions);
	delete normalizedVersions[version];
	if (!isDeepStrictEqual(normalizedVersions, baseVersions)) {
		throw new Error("versions.json changed outside the new release entry.");
	}
	return { version };
}

/**
 * @param {unknown} input
 * @param {ReturnType<typeof resolveReleaseConfig>} config
 */
export function validateReleasePr(input, config) {
	assertRecord(input, "release PR input");
	const version = assertReleaseVersion(input.version);
	const expectedFiles = [...config.files].sort();
	if (
		!Array.isArray(input.changedFiles) ||
		!input.changedFiles.every((file) => typeof file === "string") ||
		!isDeepStrictEqual([...input.changedFiles].sort(), expectedFiles)
	) {
		throw new Error(`Release PR must change exactly: ${config.files.join(", ")}.`);
	}
	if (input.baseRef !== (input.defaultBranch ?? "master")) {
		throw new Error("Release PR base must be the default branch.");
	}
	if (input.branch !== `release/${version}`) {
		throw new Error("Release PR branch/version mismatch.");
	}
	if (input.title !== `release(version): Release ${version}`) {
		throw new Error("Release PR title/version mismatch.");
	}
	if (typeof input.repository !== "string" || input.headRepository !== input.repository) {
		throw new Error("Release PR must originate from this repository.");
	}
	return { version };
}

/**
 * @param {{ root: string; artifacts: string[]; output?: string; config: ReturnType<typeof resolveReleaseConfig> }} options
 */
export function createArtifactManifest(options) {
	const config = options.config;
	if (!isDeepStrictEqual([...options.artifacts].sort(), [...config.assets].sort())) {
		throw new Error(`Release assets must be exactly: ${config.assets.join(", ")}.`);
	}
	const artifacts = options.artifacts.map((name) => {
		const contents = readRegularFile(safeFilePath(options.root, name, config));
		return { name, ...fileMetadata(contents) };
	});
	const manifest = { artifacts, schemaVersion: 1 };
	if (options.output) {
		const outputPath = path.resolve(options.output);
		const outputDirectory = fs.lstatSync(path.dirname(outputPath));
		if (!outputDirectory.isDirectory() || outputDirectory.isSymbolicLink()) {
			throw new Error(`Manifest output parent must be a real directory: ${options.output}`);
		}
		writeJson(outputPath, manifest);
	}
	return manifest;
}

/** @param {string[]} argv */
function parseOptions(argv) {
	const command = argv[0];
	/** @type {Record<string, string>} */
	const options = {};
	for (let index = 1; index < argv.length; index += 2) {
		const key = argv[index];
		const value = argv[index + 1];
		if (!key?.startsWith("--") || value === undefined) {
			throw new Error(`Invalid release-contract argument near ${String(key)}.`);
		}
		options[key.slice(2)] = value;
	}
	return { command, options };
}

/** @param {Record<string, string>} options @param {string} name */
function requiredOption(options, name) {
	const value = options[name];
	if (!value) throw new Error(`Missing --${name}.`);
	return value;
}

/** @param {Record<string, string>} options */
function configFromOptions(options) {
	return resolveReleaseConfig({
		assets: options.assets ? options.assets.split(",") : undefined,
		packageManager: options["package-manager"],
	});
}

async function main() {
	const { command, options } = parseOptions(process.argv.slice(2));
	let result;
	if (command === "files") {
		result = { files: configFromOptions(options).files };
	} else if (command === "materialize") {
		result = materializeVersionFiles({
			baseSha: requiredOption(options, "base-sha"),
			config: configFromOptions(options),
			out: requiredOption(options, "out"),
			root: requiredOption(options, "root"),
			version: requiredOption(options, "version"),
		});
	} else if (command === "validate-files") {
		result = validateVersionFiles({
			baseRoot: requiredOption(options, "base-root"),
			candidateRoot: requiredOption(options, "candidate-root"),
			config: configFromOptions(options),
			version: requiredOption(options, "version"),
		});
	} else if (command === "validate-pr") {
		const input = JSON.parse(readRegularFile(requiredOption(options, "input")).toString("utf8"));
		result = validateReleasePr(input, configFromOptions(options));
	} else if (command === "manifest") {
		result = createArtifactManifest({
			artifacts: requiredOption(options, "artifacts").split(","),
			config: configFromOptions(options),
			output: requiredOption(options, "output"),
			root: requiredOption(options, "root"),
		});
	} else {
		throw new Error(`Unknown release-contract command: ${String(command)}`);
	}
	console.log(JSON.stringify(result));
}

const isMain =
	process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
