#!/usr/bin/env node
/**
 * Package an Agent Skill for upload to claude.ai.
 *
 * claude.ai requires the .zip to contain a SINGLE top-level folder named after
 * the skill, with SKILL.md inside it (watch-vault/SKILL.md, …) — a SKILL.md at
 * the archive root fails silently on upload. We get that structure by running
 * `zip` from inside (a staging copy of) skill/ with the folder name as the arg.
 *
 * Substitution (--env): the source SKILL.md keeps its Claude Code defaults
 * (localhost endpoint, ~/.claude/skills paths) so it works here directly. When
 * an env file is passed, those env-specific literals are rewritten in a STAGING
 * COPY before zipping — so the uploaded build can point at the hosted endpoint
 * and the claude.ai file layout without touching the source.
 *
 * Usage:
 *   node scripts/pack-skill.mjs [skill-name]
 *   node scripts/pack-skill.mjs [skill-name] --env skill/pack.claude-ai.env
 */
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	rmSync,
	readFileSync,
	writeFileSync,
	existsSync,
	cpSync,
	readdirSync,
} from "node:fs";
import { join, extname } from "node:path";

// --- args --------------------------------------------------------------------
const argv = process.argv.slice(2);
let skillName = "watch-vault";
let envFile = null;
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--env") envFile = argv[++i];
	else if (!argv[i].startsWith("--")) skillName = argv[i];
}

const root = process.cwd();
const skillSrc = join(root, "skill", skillName);
const skillMd = join(skillSrc, "SKILL.md");
const outZip = join(root, "dist", `${skillName}${envFile ? ".claude-ai" : ""}.zip`);

if (!existsSync(skillMd)) {
	console.error(`pack-skill: ${skillMd} not found`);
	process.exit(1);
}

// --- validate frontmatter against claude.ai's limits -------------------------
// name: <=64 chars, lowercase letters/numbers/hyphens. description: <=200 chars.
const md = readFileSync(skillMd, "utf8");
const fm = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
if (!fm) {
	console.error("pack-skill: SKILL.md has no YAML frontmatter");
	process.exit(1);
}
const field = (name) => {
	const m = fm[1].match(new RegExp(`^${name}:\\s*(.*)$`, "m"));
	return m ? m[1].trim() : undefined;
};
const name = field("name");
const description = field("description");
let fail = false;
if (!name || !/^[a-z0-9-]{1,64}$/.test(name)) {
	console.error(`pack-skill: name "${name}" must be lowercase letters/numbers/hyphens, <=64 chars`);
	fail = true;
} else if (name !== skillName) {
	console.warn(`pack-skill: WARNING name "${name}" != folder "${skillName}" (claude.ai wants them to match)`);
}
if (!description) {
	console.error("pack-skill: frontmatter is missing `description`");
	fail = true;
} else if (description.length > 200) {
	console.warn(
		`pack-skill: WARNING description is ${description.length} chars (claude.ai limit is 200) — shorten it or the upload may reject/truncate it`,
	);
}
if (fail) process.exit(1);

// --- optional env-driven substitution into a staging copy --------------------
// Each rule maps a literal in the source to the env var that overrides it for
// the build. The source keeps the literal (works locally); the staged copy gets
// the env value. Add a rule here when a new env-specific literal needs swapping.
const RULES = [
	{ env: "ANNOTATED_MCP_ENDPOINT", find: "http://127.0.0.1:27191", label: "default endpoint" },
	{ env: "SKILL_BASE_DIR", find: `~/.claude/skills/${skillName}`, label: "bundled-script path" },
];

let zipFrom = join(root, "skill"); // default: zip straight from the source tree
let cleanup = null;

if (envFile) {
	if (!existsSync(envFile)) {
		console.error(`pack-skill: env file ${envFile} not found`);
		process.exit(1);
	}
	const env = parseEnv(readFileSync(envFile, "utf8"));
	const stageRoot = join(root, "dist", ".skill-stage");
	rmSync(stageRoot, { recursive: true, force: true });
	const stageSkill = join(stageRoot, skillName);
	mkdirSync(stageRoot, { recursive: true });
	cpSync(skillSrc, stageSkill, { recursive: true });

	const files = listTextFiles(stageSkill);
	for (const { env: key, find, label } of RULES) {
		const val = env[key];
		if (!val) {
			console.warn(`pack-skill: ${key} not set in ${envFile} — leaving ${label} unchanged`);
			continue;
		}
		let hits = 0;
		for (const f of files) {
			const before = readFileSync(f, "utf8");
			const occ = before.split(find).length - 1;
			if (occ === 0) continue;
			writeFileSync(f, before.split(find).join(val));
			hits += occ;
		}
		if (hits === 0) {
			console.warn(`pack-skill: ${key} set but "${find}" not found — nothing substituted for ${label}`);
		} else {
			console.log(`pack-skill: ${label}: "${find}" -> "${val}" (${hits} place${hits === 1 ? "" : "s"})`);
		}
	}

	// Bake the poll key for sandboxes that can't inject env vars at runtime
	// (claude.ai web). The value comes from the SHELL env at build time — never a
	// committed file — and is REDACTED from logs. The resulting zip then carries a
	// live (poll-scope) key: treat dist/*.claude-ai.zip as a secret, and rotate by
	// re-minting the key + rebuilding. In Claude Code/API the env var wins, so the
	// baked literal is only the fallback where nothing else supplies the key.
	const watchKey = process.env.ANNOTATED_WATCH_KEY;
	const bakeFind = 'WATCH_KEY_BAKED=""';
	if (watchKey) {
		const esc = watchKey.replace(/(["\\$`])/g, "\\$1");
		const repl = `WATCH_KEY_BAKED="${esc}"`;
		let hits = 0;
		for (const f of files) {
			const before = readFileSync(f, "utf8");
			const occ = before.split(bakeFind).length - 1;
			if (occ === 0) continue;
			writeFileSync(f, before.split(bakeFind).join(repl));
			hits += occ;
		}
		if (hits === 0) console.warn(`pack-skill: ANNOTATED_WATCH_KEY set but no ${bakeFind} placeholder found`);
		else console.log(`pack-skill: baked watch key into ${hits} script${hits === 1 ? "" : "s"} [redacted, ${watchKey.length} chars]`);
	} else {
		console.warn(
			"pack-skill: ANNOTATED_WATCH_KEY not set — no key baked; this build can't authenticate where env injection is unavailable (claude.ai web). Set it in your shell to bake it.",
		);
	}

	zipFrom = stageRoot;
	cleanup = () => rmSync(stageRoot, { recursive: true, force: true });
}

// --- zip with the required single-top-level-folder layout --------------------
mkdirSync(join(root, "dist"), { recursive: true });
rmSync(outZip, { force: true });
execFileSync("zip", ["-rq", outZip, skillName, "-x", "*.DS_Store", "-x", "__MACOSX/*"], {
	cwd: zipFrom,
	stdio: "inherit",
});
cleanup?.();
console.log(`pack-skill: wrote ${outZip}  (top-level folder: ${skillName}/)`);

// --- helpers -----------------------------------------------------------------
function parseEnv(text) {
	const out = {};
	for (const line of text.split(/\r?\n/)) {
		const t = line.trim();
		if (!t || t.startsWith("#")) continue;
		const eq = t.indexOf("=");
		if (eq === -1) continue;
		const k = t.slice(0, eq).trim();
		let v = t.slice(eq + 1).trim();
		if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
			v = v.slice(1, -1);
		}
		out[k] = v;
	}
	return out;
}

function listTextFiles(dir) {
	const exts = new Set([".md", ".sh", ".yml", ".yaml", ".txt"]);
	const out = [];
	const walk = (d) => {
		for (const e of readdirSync(d, { withFileTypes: true })) {
			const p = join(d, e.name);
			if (e.isDirectory()) walk(p);
			else if (exts.has(extname(e.name))) out.push(p);
		}
	};
	walk(dir);
	return out;
}
