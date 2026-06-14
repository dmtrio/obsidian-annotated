#!/usr/bin/env node
/**
 * Package an Agent Skill for upload to claude.ai.
 *
 * claude.ai requires the .zip to contain a SINGLE top-level folder named after
 * the skill, with SKILL.md inside it (watch-vault/SKILL.md, …) — a SKILL.md at
 * the archive root fails silently on upload. We get that structure by running
 * `zip` from inside skill/ with the folder name as the argument.
 *
 * Usage: node scripts/pack-skill.mjs [skill-name]   (default: watch-vault)
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const skillName = process.argv[2] ?? "watch-vault";
const root = process.cwd();
const skillDir = join(root, "skill", skillName);
const skillMd = join(skillDir, "SKILL.md");
const outZip = join(root, "dist", `${skillName}.zip`);

if (!existsSync(skillMd)) {
	console.error(`pack-skill: ${skillMd} not found`);
	process.exit(1);
}

// --- Validate the frontmatter against claude.ai's limits ---------------------
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

if (!name) {
	console.error("pack-skill: frontmatter is missing `name`");
	fail = true;
} else if (!/^[a-z0-9-]{1,64}$/.test(name)) {
	console.error(`pack-skill: name "${name}" must be lowercase letters/numbers/hyphens, <=64 chars`);
	fail = true;
} else if (name !== skillName) {
	console.warn(`pack-skill: WARNING name "${name}" != folder "${skillName}" (claude.ai wants them to match)`);
}

if (!description) {
	console.error("pack-skill: frontmatter is missing `description`");
	fail = true;
} else if (description.length > 200) {
	// Warn, don't fail: the build still produces a zip, but claude.ai may reject
	// or truncate an over-long description, hurting how the skill gets triggered.
	console.warn(
		`pack-skill: WARNING description is ${description.length} chars (claude.ai limit is 200) — shorten it or the upload may reject/truncate it`,
	);
}
if (fail) process.exit(1);

// --- Zip with the required single-top-level-folder layout --------------------
mkdirSync(join(root, "dist"), { recursive: true });
rmSync(outZip, { force: true });
execFileSync("zip", ["-rq", outZip, skillName, "-x", "*.DS_Store", "-x", "__MACOSX/*"], {
	cwd: join(root, "skill"),
	stdio: "inherit",
});
console.log(`pack-skill: wrote ${outZip}  (top-level folder: ${skillName}/)`);
