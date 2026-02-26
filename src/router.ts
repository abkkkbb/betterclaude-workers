/**
 * Router module for parsing URL-based routing patterns
 * Pattern: /claude/{host}/{path}
 *
 * Known upstream endpoints are either auto-corrected to v1/messages (common
 * misconfiguration variants) or forwarded as-is (PASSTHROUGH_PATHS).
 * Unrecognised paths cause parseRoute to return null (caller returns 400).
 */

export interface RouteInfo {
	targetHost: string;
	targetPath: string;
	searchParams: string;
}

/** Paths that are obviously meant to be v1/messages (after stripping extra slashes) */
const FIXABLE_PATHS = new Set(['', 'messages', 'v1', 'v1/messages']);

/**
 * Valid Anthropic API paths beyond v1/messages that should be forwarded to the
 * upstream as-is.  The Worker does not normalise these endpoints; the upstream
 * may return its own error (e.g. 404 when the endpoint is unsupported) which is
 * more authentic than the Worker silently rejecting with a 400.
 *
 * Current entries:
 *   - v1/messages/count_tokens – real CLI tries this first; anyrouter returns 404
 *     and the CLI falls back to a haiku max_tokens=1 probe.  Letting the 404 flow
 *     through means the CLI's fallback logic fires correctly regardless of whether
 *     the upstream ever adds support for the endpoint.
 *   - v1/chat/completions – OpenAI-compatible endpoint used by Web UI clients
 *     (Open WebUI, hapi, etc.).  Forwarded verbatim; upstream routing applies.
 */
const PASSTHROUGH_PATHS = new Set([
	'v1/messages/count_tokens',
	'v1/chat/completions',
]);

/**
 * Normalize the path segment after /claude/{host}/.
 * Returns:
 *   - "v1/messages"  for paths in FIXABLE_PATHS (common misconfiguration variants)
 *   - the cleaned path for paths in PASSTHROUGH_PATHS (valid non-messages endpoints)
 *   - null for everything else (caller returns 400 to the client)
 */
function normalizeTargetPath(raw: string): string | null {
	const cleaned = raw.replace(/^\/+|\/+$/g, '');
	if (FIXABLE_PATHS.has(cleaned)) {
		return 'v1/messages';
	}
	if (PASSTHROUGH_PATHS.has(cleaned)) {
		return cleaned;
	}
	return null;
}

/**
 * Parse URL and extract route information
 * @param url - Request URL to parse
 * @returns RouteInfo object with target host, path, and search params, or null if invalid
 */
export function parseRoute(url: URL): RouteInfo | null {
	const pattern = /^\/claude\/([^\/]+)(?:\/(.*))?$/;
	const match = url.pathname.match(pattern);

	if (!match) {
		return null;
	}

	const targetHost = match[1];
	const targetPath = normalizeTargetPath(match[2] || '');
	const searchParams = url.search;

	if (!targetPath) {
		return null;
	}

	return {
		targetHost,
		targetPath,
		searchParams,
	};
}
