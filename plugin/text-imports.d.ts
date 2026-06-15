// esbuild `text` loader (esbuild.config.mjs): import skill files (Markdown /
// YAML / shell) as plain strings so the plugin can write them to disk for the
// user (see skills-bundle.ts and the Settings → Agent skills button). These
// declarations keep TypeScript and editors happy; esbuild does the embedding.
declare module "*.md" {
	const content: string;
	export default content;
}
declare module "*.yml" {
	const content: string;
	export default content;
}
declare module "*.sh" {
	const content: string;
	export default content;
}
