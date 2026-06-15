// Skill files embedded into the bundle at build time (esbuild `text` loader).
// The plugin writes these to <plugin-dir>/skills/ so the user can copy a skill
// into ~/.claude/skills/ (Claude Code) or zip the folder to upload on claude.ai.
// Add a file here when a skill gains one; the source of truth stays in skills/.
import reviewVaultSkill from "../skills/review-vault/SKILL.md";
import watchVaultSkill from "../skills/watch-vault/SKILL.md";
import wvActive from "../skills/watch-vault/actions/active.yml";
import wvProofread from "../skills/watch-vault/actions/proofread.yml";
import wvReview from "../skills/watch-vault/actions/review.yml";
import wvSummarize from "../skills/watch-vault/actions/summarize.yml";
import wvTranslate from "../skills/watch-vault/actions/translate.yml";
import wvComments from "../skills/watch-vault/watch-comments.sh";
import wvFrontmatter from "../skills/watch-vault/watch-frontmatter.sh";

/** skill name → relative file path within the skill → file contents. */
export const SKILL_FILES: Record<string, Record<string, string>> = {
	"review-vault": {
		"SKILL.md": reviewVaultSkill,
	},
	"watch-vault": {
		"SKILL.md": watchVaultSkill,
		"actions/active.yml": wvActive,
		"actions/proofread.yml": wvProofread,
		"actions/review.yml": wvReview,
		"actions/summarize.yml": wvSummarize,
		"actions/translate.yml": wvTranslate,
		"watch-comments.sh": wvComments,
		"watch-frontmatter.sh": wvFrontmatter,
	},
};
