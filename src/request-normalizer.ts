/**
 * Request normalizer for anyrouter.top upstream
 *
 * Automatically adjusts request headers and body based on the model field
 * to satisfy upstream validation requirements. Only activates when the
 * target host is anyrouter.top.
 */

import {
	BILLING_HEADER_TEXT,
	IDENTITY_TEXT,
	SYSTEM_INSTRUCTIONS_TEXT,
	CLAUDE_CODE_TOOLS,
} from './claude-code-identity';

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
			'claude-code-20250219,adaptive-thinking-2026-01-28,prompt-caching-scope-2026-01-05,effort-2025-11-24',
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
	['Accept-Encoding', 'gzip, deflate, br, zstd'],
	['User-Agent', 'claude-cli/2.1.45 (external, cli)'],
	['X-Stainless-Arch', 'x64'],
	['X-Stainless-Lang', 'js'],
	['X-Stainless-OS', 'Windows'],
	['X-Stainless-Package-Version', '0.74.0'],
	['X-Stainless-Retry-Count', '0'],
	['X-Stainless-Runtime', 'node'],
	['X-Stainless-Runtime-Version', 'v24.3.0'],
	['X-Stainless-Timeout', '600'],
	['anthropic-dangerous-direct-browser-access', 'true'],
	['anthropic-version', '2023-06-01'],
	['x-app', 'cli'],
];

/** Pattern for Claude Code session user_id: user_{hex}_account__session_{uuid} */
const CLAUDE_CODE_USER_ID_PATTERN = /^user_[a-f0-9]+_account__session_[0-9a-f-]{36}$/;

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
 * Handles: array (pass-through), string (wrap in text block),
 * single object block (wrap in array), other (empty).
 */
function normalizeSystemToArray(system: unknown): unknown[] {
	if (Array.isArray(system)) return [...system];
	if (typeof system === 'string' && system.trim().length > 0) {
		return [{ type: 'text', text: system }];
	}
	if (isRecord(system) && typeof system.type === 'string') {
		return [{ ...system }];
	}
	return [];
}

/** Check whether a system block contains the Claude Code identity text */
function hasClaudeCodeIdentity(block: unknown): boolean {
	return isRecord(block) && typeof block.text === 'string' && block.text.includes(IDENTITY_TEXT);
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
	// For claude-code models (sonnet/opus): enforce full 3-segment system
	// structure [billing, identity, instructions] plus tools and metadata.
	if (rule.requireClaudeCodeIdentity) {
		// --- system: enforce 3-segment Claude Code structure ---
		// system[0]: billing header (no cache_control)
		// system[1]: identity line (with cache_control)
		// system[2]: full instructions (with cache_control)
		const billingBlock = { type: 'text', text: BILLING_HEADER_TEXT };
		const identityBlock = {
			type: 'text',
			text: IDENTITY_TEXT,
			cache_control: { type: 'ephemeral' },
		};
		const instructionsBlock = {
			type: 'text',
			text: SYSTEM_INSTRUCTIONS_TEXT,
			cache_control: { type: 'ephemeral' },
		};
		const systemArray = normalizeSystemToArray(bodyObj.system);

		if (systemArray.length === 0) {
			// No system provided — inject full Claude Code system
			bodyObj.system = [billingBlock, identityBlock, instructionsBlock];
		} else if (
			isRecord(systemArray[0]) &&
			typeof (systemArray[0] as Record<string, unknown>).text === 'string' &&
			((systemArray[0] as Record<string, unknown>).text as string).includes('x-anthropic-billing-header')
		) {
			// Already has billing header — this is from a real CLI. Preserve as-is
			// but ensure cache_control is present on identity block.
			if (systemArray.length >= 2 && isRecord(systemArray[1])) {
				const second = systemArray[1] as Record<string, unknown>;
				if (!isRecord(second.cache_control)) {
					second.cache_control = { type: 'ephemeral' };
				}
			}
			bodyObj.system = systemArray;
		} else if (hasClaudeCodeIdentity(systemArray[0])) {
			// Has identity line but no billing header — prepend billing + ensure instructions
			const first = systemArray[0] as Record<string, unknown>;
			if (!isRecord(first.cache_control)) {
				first.cache_control = { type: 'ephemeral' };
			}
			// Check if any subsequent block looks like the full instructions
			const hasInstructions = systemArray.slice(1).some(
				(b) => isRecord(b) && typeof (b as Record<string, unknown>).text === 'string' &&
					((b as Record<string, unknown>).text as string).length > 5000,
			);
			if (hasInstructions) {
				bodyObj.system = [billingBlock, ...systemArray];
			} else {
				bodyObj.system = [billingBlock, ...systemArray, instructionsBlock];
			}
		} else {
			// Client has its own system prompt — prepend full Claude Code structure
			bodyObj.system = [billingBlock, identityBlock, instructionsBlock, ...systemArray];
		}

		// --- tools: upstream expects non-empty tools for claude-code mode ---
		if (!Array.isArray(bodyObj.tools) || (bodyObj.tools as unknown[]).length === 0) {
			bodyObj.tools = JSON.parse(JSON.stringify(CLAUDE_CODE_TOOLS));
		}

		// --- metadata: user_id must match Claude Code session format ---
		const metadata = isRecord(bodyObj.metadata) ? { ...bodyObj.metadata } : {};
		if (typeof metadata.user_id !== 'string' || !CLAUDE_CODE_USER_ID_PATTERN.test(metadata.user_id)) {
			metadata.user_id = buildClaudeCodeUserId();
		}
		bodyObj.metadata = metadata;

		// --- output_config: required for effort-based thinking (opus only) ---
		if (rule.anthropicBeta.includes('effort-') && !isRecord(bodyObj.output_config)) {
			bodyObj.output_config = { effort: 'medium' };
		}
	} else {
		// Non-claude-code models (haiku): lenient defaults
		const hasValidSystem =
			(Array.isArray(bodyObj.system) && (bodyObj.system as unknown[]).length > 0) ||
			(typeof bodyObj.system === 'string' && (bodyObj.system as string).trim().length > 0);

		if (!hasValidSystem) {
			bodyObj.system = [{ type: 'text', text: IDENTITY_TEXT }];
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
