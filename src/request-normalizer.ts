/**
 * Request normalizer for anyrouter.top upstream
 *
 * Automatically adjusts request headers and body based on the model field
 * to satisfy upstream validation requirements. Only activates when the
 * target host is anyrouter.top.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ModelRule {
	/** Substring to match against body.model (case-insensitive) */
	keyword: string;
	/** Value to set for the anthropic-beta request header */
	anthropicBeta: string;
	/** Thinking configuration to inject into body; undefined = remove thinking */
	thinking?: Record<string, unknown>;
	/** Whether to strip body.temperature (required when thinking is enabled) */
	removeTemperature: boolean;
	/** Whether upstream validates the system prompt in claude-code mode */
	requireClaudeCodeIdentity: boolean;
}

export interface NormalizeResult {
	headers: Headers;
	body: Record<string, unknown>;
	bodyText: string;
	/** true if any modification was made */
	normalized: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_RULES: readonly ModelRule[] = [
	{
		keyword: 'haiku',
		anthropicBeta:
			'interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05,structured-outputs-2025-12-15',
		// haiku: no thinking config
		removeTemperature: false,
		requireClaudeCodeIdentity: false,
	},
	{
		keyword: 'sonnet',
		anthropicBeta:
			'claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05',
		thinking: { type: 'enabled', budget_tokens: 10000 },
		removeTemperature: true,
		requireClaudeCodeIdentity: true,
	},
	{
		keyword: 'opus',
		anthropicBeta:
			'claude-code-20250219,prompt-caching-scope-2026-01-05,effort-2025-11-24,adaptive-thinking-2026-01-28',
		thinking: { type: 'adaptive' },
		removeTemperature: true,
		requireClaudeCodeIdentity: true,
	},
];

/**
 * Headers that identify the request as coming from Claude Code CLI.
 * Always force-set to override any client-supplied values (e.g. Python-urllib UA).
 */
const CLAUDE_CODE_HEADERS: ReadonlyArray<[string, string]> = [
	['Accept', 'application/json'],
	['User-Agent', 'claude-cli/2.1.38 (external, cli)'],
	['X-Stainless-Arch', 'x64'],
	['X-Stainless-Lang', 'js'],
	['X-Stainless-OS', 'Windows'],
	['X-Stainless-Package-Version', '0.73.0'],
	['X-Stainless-Retry-Count', '0'],
	['X-Stainless-Runtime', 'node'],
	['X-Stainless-Runtime-Version', 'v24.3.0'],
	['X-Stainless-Timeout', '600'],
	['anthropic-dangerous-direct-browser-access', 'true'],
	['anthropic-version', '2023-06-01'],
	['x-app', 'cli'],
];

/** System prompt identity text that upstream expects as the first system block */
const CLAUDE_CODE_IDENTITY_TEXT = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Pattern for Claude Code session user_id: user_{hex}_account__session_{uuid} */
const CLAUDE_CODE_USER_ID_PATTERN = /^user_[a-f0-9]+_account__session_[0-9a-f-]{36}$/;

/**
 * Minimal set of Claude Code tools that upstream expects for claude-code mode.
 * Tool names and parameter names match real Claude Code CLI definitions.
 */
const MINIMAL_CLAUDE_CODE_TOOLS: ReadonlyArray<Record<string, unknown>> = [
	{
		name: 'Bash',
		description: 'Executes a given bash command with optional timeout.',
		input_schema: {
			type: 'object',
			properties: {
				command: { description: 'The command to execute', type: 'string' },
				timeout: { description: 'Optional timeout in milliseconds (max 600000)', type: 'number' },
				description: { description: 'Description of what this command does', type: 'string' },
			},
			required: ['command'],
			additionalProperties: false,
		},
	},
	{
		name: 'Read',
		description: 'Reads a file from the local filesystem.',
		input_schema: {
			type: 'object',
			properties: {
				file_path: { description: 'The absolute path to the file to read', type: 'string' },
				offset: { description: 'The line number to start reading from', type: 'number' },
				limit: { description: 'The number of lines to read', type: 'number' },
			},
			required: ['file_path'],
			additionalProperties: false,
		},
	},
	{
		name: 'Edit',
		description: 'Performs exact string replacements in files.',
		input_schema: {
			type: 'object',
			properties: {
				file_path: { description: 'The absolute path to the file to modify', type: 'string' },
				old_string: { description: 'The text to replace', type: 'string' },
				new_string: { description: 'The text to replace it with', type: 'string' },
				replace_all: { description: 'Replace all occurrences', default: false, type: 'boolean' },
			},
			required: ['file_path', 'old_string', 'new_string'],
			additionalProperties: false,
		},
	},
	{
		name: 'Write',
		description: 'Writes a file to the local filesystem.',
		input_schema: {
			type: 'object',
			properties: {
				file_path: { description: 'The absolute path to the file to write', type: 'string' },
				content: { description: 'The content to write to the file', type: 'string' },
			},
			required: ['file_path', 'content'],
			additionalProperties: false,
		},
	},
	{
		name: 'Glob',
		description: 'Fast file pattern matching tool that works with any codebase size.',
		input_schema: {
			type: 'object',
			properties: {
				pattern: { description: 'The glob pattern to match files against', type: 'string' },
				path: { description: 'The directory to search in', type: 'string' },
			},
			required: ['pattern'],
			additionalProperties: false,
		},
	},
	{
		name: 'Grep',
		description: 'A powerful search tool built on ripgrep.',
		input_schema: {
			type: 'object',
			properties: {
				pattern: { description: 'The regex pattern to search for', type: 'string' },
				path: { description: 'File or directory to search in', type: 'string' },
			},
			required: ['pattern'],
			additionalProperties: false,
		},
	},
	{
		name: 'Task',
		description: 'Launch a new agent to handle complex, multi-step tasks autonomously.',
		input_schema: {
			type: 'object',
			properties: {
				description: { description: 'A short description of the task', type: 'string' },
				prompt: { description: 'The task for the agent to perform', type: 'string' },
				subagent_type: { description: 'The type of specialized agent to use', type: 'string' },
			},
			required: ['description', 'prompt', 'subagent_type'],
			additionalProperties: false,
		},
	},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAnyrouterTarget(host: string): boolean {
	return host.toLowerCase().includes('anyrouter.top');
}

function findMatchingRule(model: string): ModelRule | undefined {
	const lower = model.toLowerCase();
	return MODEL_RULES.find((rule) => lower.includes(rule.keyword));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize system field to array format.
 * Handles: array (pass-through), string (wrap in text block), other (empty).
 */
function normalizeSystemToArray(system: unknown): unknown[] {
	if (Array.isArray(system)) return [...system];
	if (typeof system === 'string' && system.trim().length > 0) {
		return [{ type: 'text', text: system }];
	}
	return [];
}

/** Check whether a system block contains the Claude Code identity text */
function hasClaudeCodeIdentity(block: unknown): boolean {
	return isRecord(block) && typeof block.text === 'string' && block.text.includes(CLAUDE_CODE_IDENTITY_TEXT);
}

/** Generate a user_id matching the Claude Code session format */
function buildClaudeCodeUserId(): string {
	const hash = crypto.randomUUID().replace(/-/g, '');
	const sessionId = crypto.randomUUID();
	return `user_${hash}_account__session_${sessionId}`;
}

/**
 * Browser fingerprint headers that must be stripped for anyrouter.top.
 * Electron/browser clients (e.g. Cherry Studio) send these automatically;
 * their presence exposes the request as non-CLI and triggers upstream rejection.
 */
const BROWSER_FINGERPRINT_HEADERS: readonly string[] = [
	'sec-ch-ua',
	'sec-ch-ua-platform',
	'sec-ch-ua-mobile',
	'sec-fetch-site',
	'sec-fetch-mode',
	'sec-fetch-dest',
	'accept-language',
	'priority',
	'origin',
	'referer',
];

function stripBrowserHeaders(headers: Headers): void {
	for (const key of BROWSER_FINGERPRINT_HEADERS) {
		headers.delete(key);
	}
}

/**
 * Force-set Claude Code identification headers.
 * These are always overwritten (not "fill if missing") because the client's
 * original User-Agent / fingerprint headers would expose the real caller
 * and get blocked by upstream Cloudflare bot-detection (error 1010).
 */
function applyClaudeCodeHeaders(headers: Headers): void {
	for (const [key, value] of CLAUDE_CODE_HEADERS) {
		headers.set(key, value);
	}
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Normalize a request destined for anyrouter.top.
 *
 * When the target host contains "anyrouter.top" and body.model matches a known
 * model family (haiku / sonnet / opus), the function:
 *   1. Overwrites the `anthropic-beta` header with the model-specific value
 *   2. Sets or removes `body.thinking` per model requirements
 *   3. Removes `body.temperature` when thinking is active
 *   4. Strips browser fingerprint headers and force-sets Claude Code identity
 *   5. Normalizes auth header (x-api-key → Authorization Bearer)
 *   6. Forces `body.stream = true`
 *   7. Ensures `body.system`, `body.tools`, `body.metadata`, `body.max_tokens` have
 *      valid defaults (preserves client-provided system/tools when present)
 *   8. Removes stale `content-length` so fetch() recalculates from new body
 *
 * For unrecognised models or non-anyrouter targets the request passes through
 * unmodified.
 *
 * @param targetHost - The upstream host extracted from the route
 * @param headers    - Mutable Headers object (will be modified in place)
 * @param body       - Parsed JSON body (will be modified in place)
 * @param bodyText   - Original serialized body text (returned as-is when no changes)
 */
export function normalizeRequest(
	targetHost: string,
	headers: Headers,
	body: unknown,
	bodyText: string,
): NormalizeResult {
	// Guard: only act on anyrouter.top targets
	if (!isAnyrouterTarget(targetHost)) {
		return { headers, body: body as Record<string, unknown>, bodyText, normalized: false };
	}

	// Guard: body must be a non-null object
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return { headers, body: body as Record<string, unknown>, bodyText, normalized: false };
	}

	const bodyObj = body as Record<string, unknown>;

	// Guard: model must be a string
	if (typeof bodyObj.model !== 'string') {
		return { headers, body: bodyObj, bodyText, normalized: false };
	}

	// Guard: model must match a known rule
	const rule = findMatchingRule(bodyObj.model);
	if (!rule) {
		return { headers, body: bodyObj, bodyText, normalized: false };
	}

	// --- Apply normalizations ---

	// 1. Overwrite anthropic-beta header
	headers.set('anthropic-beta', rule.anthropicBeta);

	// 2. Set or remove thinking
	if (rule.thinking) {
		bodyObj.thinking = rule.thinking;
	} else {
		delete bodyObj.thinking;
	}

	// 3. Remove temperature when thinking is active
	if (rule.removeTemperature) {
		delete bodyObj.temperature;
	}

	// 4. Strip browser fingerprint headers then force Claude Code identity
	stripBrowserHeaders(headers);
	applyClaudeCodeHeaders(headers);

	// 5. Normalize auth header: convert x-api-key to Authorization Bearer format
	// Upstream may require Bearer format when claude-code beta is active
	const apiKey = headers.get('x-api-key');
	if (apiKey && !headers.get('Authorization')) {
		headers.set('Authorization', `Bearer ${apiKey}`);
		headers.delete('x-api-key');
	}

	// 6. Default to streaming if not explicitly set by client
	if (bodyObj.stream === undefined || bodyObj.stream === null) {
		bodyObj.stream = true;
	}

	// 7. Ensure body fields satisfy upstream claude-code validation.
	// For claude-code models (sonnet/opus): enforce identity shape while
	// preserving the client's own system content alongside it.
	if (rule.requireClaudeCodeIdentity) {
		// --- system: ensure Claude Code identity is the first element ---
		const identityBlock = {
			type: 'text',
			text: CLAUDE_CODE_IDENTITY_TEXT,
			cache_control: { type: 'ephemeral' },
		};
		const systemArray = normalizeSystemToArray(bodyObj.system);

		if (systemArray.length === 0) {
			bodyObj.system = [identityBlock];
		} else if (hasClaudeCodeIdentity(systemArray[0])) {
			// Already has identity; ensure cache_control is present
			const first = systemArray[0] as Record<string, unknown>;
			if (!isRecord(first.cache_control)) {
				first.cache_control = { type: 'ephemeral' };
			}
			bodyObj.system = systemArray;
		} else {
			// Client has its own system prompt — prepend identity before it
			bodyObj.system = [identityBlock, ...systemArray];
		}

		// --- tools: upstream expects non-empty tools for claude-code mode ---
		if (!Array.isArray(bodyObj.tools) || (bodyObj.tools as unknown[]).length === 0) {
			bodyObj.tools = JSON.parse(JSON.stringify(MINIMAL_CLAUDE_CODE_TOOLS));
		}

		// --- metadata: user_id must match Claude Code session format ---
		const metadata = isRecord(bodyObj.metadata) ? { ...bodyObj.metadata } : {};
		if (typeof metadata.user_id !== 'string' || !CLAUDE_CODE_USER_ID_PATTERN.test(metadata.user_id)) {
			metadata.user_id = buildClaudeCodeUserId();
		}
		bodyObj.metadata = metadata;
	} else {
		// Non-claude-code models (haiku): lenient defaults
		const hasValidSystem =
			(Array.isArray(bodyObj.system) && (bodyObj.system as unknown[]).length > 0) ||
			(typeof bodyObj.system === 'string' && (bodyObj.system as string).trim().length > 0);

		if (!hasValidSystem) {
			bodyObj.system = [{ type: 'text', text: CLAUDE_CODE_IDENTITY_TEXT }];
		}

		// Empty tools [] is valid for haiku (e.g. topic-detection requests).
		if (bodyObj.tools === undefined || !Array.isArray(bodyObj.tools)) {
			bodyObj.tools = [];
		}

		if (!bodyObj.metadata) {
			bodyObj.metadata = { user_id: 'normalized-request' };
		}
	}
	if (!bodyObj.max_tokens) {
		bodyObj.max_tokens = 32000;
	}

	// 8. Body has been modified; remove stale content-length so fetch() recalculates
	headers.delete('content-length');

	return {
		headers,
		body: bodyObj,
		bodyText: JSON.stringify(bodyObj),
		normalized: true,
	};
}
