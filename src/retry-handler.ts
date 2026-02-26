/**
 * Proactive retry handler with intelligent orphaned tool result detection
 *
 * New Logic Flow (Proactive-First):
 * 1. Parse request body to extract messages
 * 2. Run PROACTIVE detection - remove ALL orphaned tool_result blocks BEFORE API call
 * 3. Make API call with cleaned messages
 * 4. If 400 orphaned error → one-time retry to remove remaining orphan
 * 5. Return response with metadata
 */

import { detectAndRemoveOrphanedToolResults, type Message } from './proactive-cleanup';
import { detectOrphanedToolError } from './error-detector';
import { isStreamingResponse } from './streaming-handler';

/**
 * Sleep for specified milliseconds
 */
function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

/** Maximum number of retries for upstream 500 overload errors */
const MAX_OVERLOAD_RETRIES = 2;

/**
 * Detect upstream 500 overload / rate-limit errors that are safe to retry.
 *
 * Matches patterns observed from anyrouter.top and common API gateways:
 *   - "负载已经达到上限" (Chinese: load limit reached)
 *   - "overload" / "overloaded"
 *   - "rate limit"
 *   - "capacity"
 *
 * The response body is read from a *clone* so the original remains consumable.
 */
async function isOverloadError(response: Response): Promise<boolean> {
	if (response.status !== 500 && response.status !== 529 && response.status !== 503) {
		return false;
	}

	try {
		const text = await response.clone().text();
		if (!text) return false;

		let message = text;
		try {
			const parsed = JSON.parse(text);
			message = parsed?.error?.message ?? parsed?.message ?? text;
		} catch {
			// body is not JSON — use raw text
		}

		const lower = message.toLowerCase();
		return (
			message.includes('\u8D1F\u8F7D\u5DF2\u7ECF\u8FBE\u5230\u4E0A\u9650') || // 负载已经达到上限
			lower.includes('overload') ||
			lower.includes('rate limit') ||
			lower.includes('capacity') ||
			lower.includes('too many requests')
		);
	} catch {
		return false;
	}
}

/**
 * Make API call with current request body
 */
async function makeApiCall(
	request: Request,
	targetUrl: string,
	headers: Headers,
	body: string
): Promise<Response> {
	// Body may differ between attempts (proactive cleanup / retry); never
	// forward a stale content-length — let the runtime compute framing.
	headers.delete('content-length');

	return fetch(targetUrl, {
		method: request.method,
		headers,
		body,
		// @ts-ignore - duplex is valid for streaming support but not in types
		duplex: 'half',
	});
}

/**
 * Remove a specific orphaned tool_result from messages
 */
function removeOrphanedToolResult(
	messages: Message[],
	toolUseId: string
): Message[] {
	const orphanedIdsSet = new Set([toolUseId]);
	const cleanedMessages = structuredClone(messages);

	for (const message of cleanedMessages) {
		message.content = message.content.filter(block => {
			if (block.type === 'tool_result' && block.tool_use_id) {
				return !orphanedIdsSet.has(block.tool_use_id);
			}
			return true;
		});
	}

	return cleanedMessages;
}

/**
 * Proactive retry handler with intelligent cleanup
 *
 * Algorithm:
 * 1. Parse request body to extract messages
 * 2. Run PROACTIVE detection - remove ALL orphaned tool_result blocks BEFORE API call
 * 3. Make API call with cleaned messages
 * 4. If 400 orphaned error → one-time retry to remove remaining orphan
 * 5. Return response with metadata
 *
 * @param request - Original client request
 * @param targetUrl - Target API URL
 * @param headers - Request headers
 * @returns RetryResult with response and metadata
 */
export async function retryWithCleanup(
	request: Request,
	targetUrl: string,
	headers: Headers,
	providedBody?: { text: string; json?: unknown }
): Promise<RetryResult> {
	// Parse request body to extract messages
	const bodyText = providedBody?.text ?? (await request.text());
	let body: any = providedBody?.json;

	if (body === undefined) {
		try {
			body = JSON.parse(bodyText);
		} catch {
			// If body is not valid JSON, forward request as-is
			const response = await makeApiCall(request, targetUrl, headers, bodyText);

			return {
				response,
				metadata: {
					removedToolUseIds: [],
					proactiveRemovedIds: [],
					retryCount: 0,
					result: 'success',
				},
			};
		}
	}

	// If JSON isn't an object, nothing to clean up
	if (!body || typeof body !== 'object') {
		const response = await makeApiCall(request, targetUrl, headers, bodyText);
		return {
			response,
			metadata: {
				removedToolUseIds: [],
				proactiveRemovedIds: [],
				retryCount: 0,
				result: 'success',
			},
		};
	}

	// Extract messages array from body
	let messages: Message[] = body.messages || [];

	// Initialize metadata
	const metadata: RetryMetadata = {
		removedToolUseIds: [],
		proactiveRemovedIds: [],
		retryCount: 0,
		result: 'success',
	};

	// === Step 1: PROACTIVE DETECTION ===
	// Remove ALL orphaned tool_result blocks BEFORE making any API call
	const cleanupResult = detectAndRemoveOrphanedToolResults(messages);
	messages = cleanupResult.cleanedMessages;
	metadata.proactiveRemovedIds = cleanupResult.removedIds;

	// Update body with cleaned messages
	body.messages = messages;
	const cleanedBodyText = JSON.stringify(body);

	// Track if proactive cleanup was applied
	const hadProactiveCleanup = cleanupResult.hadOrphans;

	// === Step 2: First API call with proactively cleaned messages ===
	let response = await makeApiCall(request, targetUrl, headers, cleanedBodyText);

	// === Step 2.5: Retry transient 500 overload errors ===
	// anyrouter.top may return 500/503/529 when the upstream model is at capacity.
	// Retry up to MAX_OVERLOAD_RETRIES times with exponential back-off (1 s, 2 s).
	if (await isOverloadError(response)) {
		for (let attempt = 1; attempt <= MAX_OVERLOAD_RETRIES; attempt++) {
			metadata.retryCount = attempt;
			await sleep(1000 * (2 ** (attempt - 1))); // 1 s, 2 s

			response = await makeApiCall(request, targetUrl, headers, cleanedBodyText);
			if (!(await isOverloadError(response))) {
				break;
			}
		}
	}

	// Handle streaming responses (pass through without buffering)
	if (isStreamingResponse(response)) {
		if (metadata.retryCount > 0) {
			metadata.result = 'retry_success';
		} else if (hadProactiveCleanup) {
			metadata.result = 'proactive_success';
		} else {
			metadata.result = 'success';
		}

		return { response, metadata };
	}

	// Success - return response
	if (response.ok) {
		if (metadata.retryCount > 0) {
			metadata.result = 'retry_success';
		} else if (hadProactiveCleanup) {
			metadata.result = 'proactive_success';
		} else {
			metadata.result = 'success';
		}

		return { response, metadata };
	}

	// === Step 3: Handle 400 errors ===
	// If proactive cleanup missed something, do one-time retry
	if (response.status === 400) {
		const errorInfo = await detectOrphanedToolError(response);

		if (errorInfo.isError && errorInfo.orphanedIds.length > 0) {
			// Proactive cleanup missed some orphans - do one-time retry
			// Remove the remaining orphaned tool_result
			const lastOrphanId = errorInfo.orphanedIds[0];
			messages = removeOrphanedToolResult(messages, lastOrphanId);
			body.messages = messages;

			// Track removed IDs
			metadata.removedToolUseIds.push(...errorInfo.orphanedIds);
			metadata.retryCount += 1;

			// Small delay before retry
			await sleep(100);

			// Retry with cleaned messages
			const retryBodyText = JSON.stringify(body);
			const retryResponse = await makeApiCall(request, targetUrl, headers, retryBodyText);

			// Handle streaming for retry response
			if (isStreamingResponse(retryResponse)) {
				metadata.result = 'retry_success';
				return { response: retryResponse, metadata };
			}

			// Return retry response (success or final error)
			if (retryResponse.ok) {
				metadata.result = 'retry_success';
			}

			return { response: retryResponse, metadata };
		}
	}

	// Non-orphaned error or unknown - return original response
	return {
		response,
		metadata: {
			...metadata,
			result: metadata.retryCount > 0 ? 'retry_success' : 'success',
		},
	};
}

/**
 * Metadata about retry operations performed
 */
export interface RetryMetadata {
	removedToolUseIds: string[];
	proactiveRemovedIds: string[];
	retryCount: number;
	result: 'success' | 'proactive_success' | 'retry_success';
}

/**
 * Result of retry operation
 */
export interface RetryResult {
	response: Response;
	metadata: RetryMetadata;
}
