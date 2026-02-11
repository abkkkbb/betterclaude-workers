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
	'accept-encoding',
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
 *   4. Force-sets Claude Code identification headers (always overwrite)
 *   5. Forces `body.stream = true`
 *   6. Ensures `body.system` and `body.tools` have default values
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

	// 6. Force streaming
	bodyObj.stream = true;

	// 6. Ensure minimal required body fields for upstream validation
	if (!bodyObj.system) {
		bodyObj.system = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }];
	}
	if (!Array.isArray(bodyObj.tools) || (bodyObj.tools as unknown[]).length === 0) {
		bodyObj.tools = [
			{
				name: 'placeholder',
				description: 'placeholder tool',
				input_schema: { type: 'object', properties: {} },
			},
		];
	}
	if (!bodyObj.metadata) {
		bodyObj.metadata = { user_id: 'normalized-request' };
	}
	if (!bodyObj.max_tokens) {
		bodyObj.max_tokens = 32000;
	}

	return {
		headers,
		body: bodyObj,
		bodyText: JSON.stringify(bodyObj),
		normalized: true,
	};
}
