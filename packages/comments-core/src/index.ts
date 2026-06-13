export {
	SCHEMA_VERSION,
	type Comment,
	type CommentFile,
	type CommentFileMetadata,
	type CommentReply,
	type CommentStatus,
	type Location,
	type RangeLocation,
} from "./types";
export { type CommentStorageAdapter, InMemoryStorageAdapter } from "./storage";
export { CommentStore, type CommentStoreOptions } from "./CommentStore";
export { needsAttention, getActionableComments } from "./actionable";
export {
	pathInScope,
	queryActionable,
	toActionableRef,
	type ActionableQueryParams,
	type ActionableRef,
} from "./actionableQuery";
export {
	authenticate,
	authHttpStatus,
	bearerToken,
	canAccess,
	effectiveExcludeAuthors,
	generateIdentityId,
	hashToken,
	keyAllowsPath,
	resolveQueryScope,
	timingSafeEqualHex,
	type AuthFailureReason,
	type AuthResult,
	type Identity,
	type KeyRecord,
	type KeyScope,
	type ScopeResolution,
	type Surface,
} from "./auth";
export {
	readFrontmatter,
	applyFrontmatterEdit,
	stampProvenance,
	type FrontmatterEdit,
	type FrontmatterRead,
} from "./frontmatter";
export {
	queryActionableFrontmatter,
	type FrontmatterQueryParams,
	type FrontmatterRef,
} from "./actionableFrontmatter";
