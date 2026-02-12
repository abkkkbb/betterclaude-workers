/**
 * Router module for parsing URL-based routing patterns
 * Pattern: /claude/{host}/{path}
 *
 * The only valid upstream endpoint is v1/messages. Common path mistakes
 * (empty, "messages", "v1", "v1/") are auto-corrected to "v1/messages".
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
 * Normalize the path segment after /claude/{host}/.
 * Returns "v1/messages" for common misconfigurations, or null for invalid paths.
 */
function normalizeTargetPath(raw: string): string | null {
	const cleaned = raw.replace(/^\/+|\/+$/g, '');
	if (FIXABLE_PATHS.has(cleaned)) {
		return 'v1/messages';
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
