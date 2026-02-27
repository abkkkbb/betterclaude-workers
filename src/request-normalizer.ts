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
	/**
	 * Beta flags this model MUST have.  These are merged additively into the
	 * client's existing `anthropic-beta` header — never replacing it wholesale —
	 * so client-negotiated flags (e.g. `context-1m-2025-08-07`,
	 * `structured-outputs-2025-12-15`) are always preserved.
	 */
	requiredBetaFlags: readonly string[];
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
		// Only the two flags real CLI always sends for haiku.
		// `structured-outputs-2025-12-15` is present in topic-detection requests
		// but absent in token-count fallback requests — preserve whatever the
		// client already sent rather than forcing it onto every haiku call.
		requiredBetaFlags: [
			'interleaved-thinking-2025-05-14',
			'prompt-caching-scope-2026-01-05',
		],
		// haiku: no thinking config
		removeTemperature: false,
		requireClaudeCodeIdentity: false,
	},
	{
		keyword: 'sonnet',
		// `context-1m-2025-08-07` is intentionally omitted: real CLI only sends
		// it when 1M-context mode is active.  Preserve it if the client supplied
		// it; do not inject it unconditionally.
		requiredBetaFlags: [
			'claude-code-20250219',
			'interleaved-thinking-2025-05-14',
			'prompt-caching-scope-2026-01-05',
			'effort-2025-11-24',
			'adaptive-thinking-2026-01-28',
		],
		thinking: { type: 'adaptive' },
		removeTemperature: true,
		requireClaudeCodeIdentity: true,
	},
	{
		keyword: 'opus',
		// Same rationale as sonnet: `context-1m-2025-08-07` is client-controlled.
		requiredBetaFlags: [
			'claude-code-20250219',
			'interleaved-thinking-2025-05-14',
			'prompt-caching-scope-2026-01-05',
			'effort-2025-11-24',
			'adaptive-thinking-2026-01-28',
		],
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
	['User-Agent', 'claude-cli/2.1.59 (external, sdk-ts)'],
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

/**
 * Protocol-critical headers that must always be force-set regardless of caller type.
 * Runtime fingerprint headers (User-Agent, X-Stainless-*) are excluded — they are
 * preserved for real CLI callers to avoid upstream mismatch detection.
 */
const PROTOCOL_CRITICAL_HEADERS = new Set([
	'accept',
	'accept-encoding',
	'anthropic-dangerous-direct-browser-access',
	'anthropic-version',
	'x-app',
]);

/** Pattern for Claude Code session user_id: user_{hex}_account__session_{uuid} */
const CLAUDE_CODE_USER_ID_PATTERN = /^user_[a-f0-9]+_account__session_[0-9a-f-]{36}$/;

/**
 * Stable identity prefix shared by all known Claude Code CLI versions.
 *
 * v2.1.50 and earlier: "You are Claude Code, Anthropic's official CLI for Claude."
 * v2.1.59 and later:   "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK."
 *
 * Using startsWith on this common prefix (without trailing punctuation) makes
 * detection forward-compatible with future suffix changes.
 */
const IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude";

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
 * Merge model-required beta flags into the client's existing `anthropic-beta`
 * header value without discarding any flags the client already negotiated.
 *
 * Algorithm:
 *   1. Split the existing header value by comma, trim each token, drop empties.
 *   2. Insert each token into a Set (deduplicates automatically).
 *   3. Append any flag from `required` that is not yet in the Set.
 *   4. Return the Set members joined by commas, preserving insertion order
 *      (existing flags first, new required flags appended at the end).
 *
 * This guarantees that:
 *   - Client-negotiated flags such as `context-1m-2025-08-07` and
 *     `structured-outputs-2025-12-15` are never stripped.
 *   - Every flag in `required` is present in the final header value.
 *
 * @param existing - Raw `anthropic-beta` header value from the incoming request,
 *                   or null if the header was absent.
 * @param required - Flags the matched model rule mandates.
 * @returns Comma-separated merged flag string with no duplicates.
 */
function mergeBetaFlags(existing: string | null, required: readonly string[]): string {
	const presentFlags = new Set(
		(existing ?? '').split(',').map((f) => f.trim()).filter((f) => f.length > 0),
	);
	for (const flag of required) {
		presentFlags.add(flag);
	}
	return [...presentFlags].join(',');
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

/** Check whether a system block starts with the Claude Code identity prefix (version-agnostic) */
function hasClaudeCodeIdentity(block: unknown): boolean {
	return isRecord(block) && typeof block.text === 'string' && block.text.startsWith(IDENTITY_PREFIX);
}

/** Generate a user_id matching the Claude Code session format */
function buildClaudeCodeUserId(): string {
	const hash = crypto.randomUUID().replace(/-/g, '');
	const sessionId = crypto.randomUUID();
	return `user_${hash}_account__session_${sessionId}`;
}

/**
 * Determine whether the incoming request originates from the Claude  Code CLI
 * rather than a generic Web UI or OpenAI-compatible client (e.g. Open WebUI).
 *
 * Any one of the following conditions is sufficient to identify a CLI request:
 *   1. `anthropic-beta` already contains `claude-code-20250219` — real CLI always
 *      negotiates this flag; generic clients do not.
 *   2. The first `system` block's text contains `x-anthropic-billing-header` —
 *      the billing-envelope sentinel injected by the CLI's session initialisation.
 *   3. `User-Agent` starts with `claude-cli/`.
 *
 * IMPORTANT: Must be called BEFORE `applyClaudeCodeHeaders`, which may overwrite
 * the User-Agent during normalization for non-CLI callers, making
 * condition 3 permanently true afterwards.
 */
function isClaudeCodeCliRequest(
	headers: Headers,
	bodyObj: Record<string, unknown>,
): boolean {
	// Condition 1: CLI-exclusive anthropic-beta flag
	const betaFlags = (headers.get('anthropic-beta') ?? '')
		.split(',')
		.map((f) => f.trim());
	if (betaFlags.includes('claude-code-20250219')) return true;

	// Condition 2: billing-envelope sentinel in first system block
	const systemArray = normalizeSystemToArray(bodyObj.system);
	if (
		systemArray.length > 0 &&
		isRecord(systemArray[0]) &&
		typeof (systemArray[0] as Record<string, unknown>).text === 'string' &&
		((systemArray[0] as Record<string, unknown>).text as string).includes('x-anthropic-billing-header')
	) {
		return true;
	}

	// Condition 3: CLI User-Agent prefix (valid only before applyClaudeCodeHeaders)
	return (headers.get('user-agent') ?? '').startsWith('claude-cli/');
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
 * Apply Claude Code identification headers.
 *
 * - Protocol-critical headers (Accept, anthropic-version, x-app, etc.) are always set.
 * - Runtime fingerprint headers (User-Agent, X-Stainless-*) are only overwritten
 *   for non-CLI callers. Real CLI callers keep their original values to avoid
 *   upstream version/type mismatch detection.
 *
 * @param headers - Mutable Headers object
 * @param overwriteAll - When true, overwrite all headers (non-CLI callers).
 *                       When false, only set protocol-critical or missing headers.
 */
function applyClaudeCodeHeaders(headers: Headers, overwriteAll: boolean): void {
	for (const [key, value] of CLAUDE_CODE_HEADERS) {
		const lowerKey = key.toLowerCase();
		if (overwriteAll || PROTOCOL_CRITICAL_HEADERS.has(lowerKey) || !headers.has(key)) {
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
 *   1. Merges required beta flags into the existing `anthropic-beta` header
 *      (additive: client flags are preserved; only missing required flags are appended)
 *   2. Sets or removes `body.thinking` per model requirements
 *   3. Removes `body.temperature` when thinking is active
 *   4. Strips browser fingerprint headers and force-sets Claude Code identity
 *   5. Normalizes auth header (x-api-key → Authorization Bearer)
 *   6. Forces `body.stream = true`
 *   7. Ensures `body.system`, `body.tools`, `body.metadata`, `body.max_tokens` satisfy
 *      upstream requirements.  CLI requests receive full normalization (system identity,
 *      CLAUDE_CODE_TOOLS, metadata.user_id).  Generic Web UI requests receive lightweight
 *      normalization (identity prefix prepended, tools preserved as-is, metadata.user_id).
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

	// Pre-step A: Capture original User-Agent before any header mutations.
	// Used to decide whether runtime fingerprint headers should be preserved.
	const isOriginalCliRequest = (headers.get('user-agent') ?? '').startsWith('claude-cli/');

	// Pre-step B: Detect CLI origin from the unmodified client headers.
	// This MUST run before mergeBetaFlags (step 1), which unconditionally injects
	// `claude-code-20250219` for sonnet/opus — making condition 1 inside
	// isClaudeCodeCliRequest permanently true for ALL clients if called afterwards.
	const isCli = rule.requireClaudeCodeIdentity
		? isClaudeCodeCliRequest(headers, bodyObj)
		: false; // haiku never requires identity differentiation

	// 1. Merge required beta flags into the client's existing anthropic-beta header.
	// Additive: client flags are preserved; only missing required flags are appended.
	headers.set('anthropic-beta', mergeBetaFlags(headers.get('anthropic-beta'), rule.requiredBetaFlags));

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
	applyClaudeCodeHeaders(headers, !isOriginalCliRequest);

	// 5. Normalize auth header: convert x-api-key to Authorization Bearer format
	// Upstream may require Bearer format when claude-code beta is active
	const apiKey = headers.get('x-api-key');
	if (apiKey && !headers.get('Authorization')) {
		headers.set('Authorization', `Bearer ${apiKey}`);
		headers.delete('x-api-key');
	}

	// 6. Preserve client's stream setting.
	// Real CLI always sends stream=true explicitly.
	// Non-CLI test endpoints (new-api channel test) may omit it or set false,
	// and expect a non-streaming JSON response. Do NOT force stream=true.

	// 7. Ensure body fields satisfy upstream claude-code validation.
	// For claude-code models (sonnet/opus): enforce Claude Code system
	// structure plus tools and metadata.
	// Supports both legacy 3-block [billing, identity, instructions] and
	// new 2-block [identity, instructions] formats depending on whether
	// BILLING_HEADER_TEXT is populated.
	if (rule.requireClaudeCodeIdentity && isCli) {
		// -------------------------------------------------------------------------
		// CLI path: full normalization — repairs any gaps in a real CLI request
		// -------------------------------------------------------------------------
		const hasBilling = BILLING_HEADER_TEXT.length > 0;
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

		// Build the canonical system prefix (with or without billing)
		const canonicalPrefix = hasBilling
			? [{ type: 'text', text: BILLING_HEADER_TEXT }, identityBlock, instructionsBlock]
			: [identityBlock, instructionsBlock];

		const systemArray = normalizeSystemToArray(bodyObj.system);

		if (systemArray.length === 0) {
			// No system provided — inject full Claude Code system
			bodyObj.system = canonicalPrefix;
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
			// Has identity line but no billing header — ensure instructions present
			const first = systemArray[0] as Record<string, unknown>;
			if (!isRecord(first.cache_control)) {
				first.cache_control = { type: 'ephemeral' };
			}
			// Check if any subsequent block looks like the full instructions
			const hasInstructions = systemArray.slice(1).some(
				(b) => isRecord(b) && typeof (b as Record<string, unknown>).text === 'string' &&
					((b as Record<string, unknown>).text as string).length > 5000,
			);
			if (hasBilling) {
				const billingBlock = { type: 'text', text: BILLING_HEADER_TEXT };
				if (hasInstructions) {
					bodyObj.system = [billingBlock, ...systemArray];
				} else {
					bodyObj.system = [billingBlock, ...systemArray, instructionsBlock];
				}
			} else {
				if (hasInstructions) {
					bodyObj.system = systemArray;
				} else {
					bodyObj.system = [...systemArray, instructionsBlock];
				}
			}
		} else {
			// Client has its own system prompt — prepend full Claude Code structure
			bodyObj.system = [...canonicalPrefix, ...systemArray];
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

		// output_config: real CLI does NOT send output_config for sonnet/opus.
		// Adaptive thinking (thinking.type=adaptive) determines effort level
		// automatically. Injecting output_config.effort would be extraneous and
		// may trigger "invalid claude code request" on anyrouter.top.
		// Only preserve output_config if the client explicitly provided one
		// (e.g. structured-output format requests).
	} else if (rule.requireClaudeCodeIdentity && !isCli) {
		// -------------------------------------------------------------------------
		// Generic path: Web UI / OpenAI-compatible clients (sonnet / opus).
		// Fix headers only; preserve the client's tools and system prompt structure
		// to avoid token bloat and model behaviour changes.
		// -------------------------------------------------------------------------
		const hasBilling = BILLING_HEADER_TEXT.length > 0;
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
		const canonicalPrefix = hasBilling
			? [{ type: 'text', text: BILLING_HEADER_TEXT }, identityBlock, instructionsBlock]
			: [identityBlock, instructionsBlock];

		// System: prepend canonical identity only when not already present.
		// The client's own system prompt is preserved immediately after.
		const systemArray = normalizeSystemToArray(bodyObj.system);
		const alreadyHasIdentity = systemArray.some((b) => hasClaudeCodeIdentity(b));
		if (alreadyHasIdentity) {
			bodyObj.system = systemArray;
		} else {
			bodyObj.system = systemArray.length > 0
				? [...canonicalPrefix, ...systemArray]
				: canonicalPrefix;
		}

		// Tools: anyrouter.top requires non-empty tools when claude-code-20250219
		// beta flag is present for sonnet/opus models. Inject Claude Code tools
		// when client did not provide any; preserve client tools if non-empty.
		if (!Array.isArray(bodyObj.tools) || (bodyObj.tools as unknown[]).length === 0) {
			bodyObj.tools = JSON.parse(JSON.stringify(CLAUDE_CODE_TOOLS));
		}

		// Metadata: enforce valid user_id format (same rule as CLI path).
		const metadata = isRecord(bodyObj.metadata) ? { ...bodyObj.metadata } : {};
		if (typeof metadata.user_id !== 'string' || !CLAUDE_CODE_USER_ID_PATTERN.test(metadata.user_id)) {
			metadata.user_id = buildClaudeCodeUserId();
		}
		bodyObj.metadata = metadata;

		// output_config: same as CLI path — do NOT inject output_config.effort.
		// Adaptive thinking determines effort automatically; extraneous
		// output_config may cause upstream validation failures.
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
