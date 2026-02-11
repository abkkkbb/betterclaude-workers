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
	},
	{
		keyword: 'sonnet',
		anthropicBeta:
			'claude-code-20250219,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05',
		thinking: { type: 'enabled', budget_tokens: 10000 },
		removeTemperature: true,
	},
	{
		keyword: 'opus',
		anthropicBeta:
			'claude-code-20250219,prompt-caching-scope-2026-01-05,effort-2025-11-24,adaptive-thinking-2026-01-28',
		thinking: { type: 'adaptive' },
		removeTemperature: true,
	},
];

/**
 * Default headers that identify the request as coming from Claude Code CLI.
 * Only set when the header is not already present in the request.
 */
const CLAUDE_CODE_HEADERS: ReadonlyArray<[string, string]> = [
	['User-Agent', 'claude-cli/2.1.38 (external, cli)'],
	['X-Stainless-Arch', 'x64'],
	['X-Stainless-Lang', 'js'],
	['X-Stainless-OS', 'Windows'],
	['X-Stainless-Package-Version', '0.51.0'],
	['X-Stainless-Runtime', 'node'],
	['X-Stainless-Runtime-Version', 'v22.14.0'],
	['anthropic-dangerous-direct-browser-access', 'true'],
	['x-app', 'cli'],
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

function ensureClaudeCodeHeaders(headers: Headers): void {
	for (const [key, value] of CLAUDE_CODE_HEADERS) {
		if (!headers.has(key)) {
			headers.set(key, value);
		}
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
 *   4. Fills in missing Claude Code identification headers
 *   5. Forces `body.stream = true`
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

	// 4. Ensure Claude Code identification headers
	ensureClaudeCodeHeaders(headers);

	// 5. Force streaming
	bodyObj.stream = true;

	return {
		headers,
		body: bodyObj,
		bodyText: JSON.stringify(bodyObj),
		normalized: true,
	};
}
