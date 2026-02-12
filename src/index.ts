/**
 * BetterClaude API Gateway
 * A Cloudflare Worker that proxies requests to Claude API with retry handling
 */

export default {
	/**
	 * This is the standard fetch handler for a Cloudflare Worker
	 *
	 * @param request - The request submitted to the Worker from the client
	 * @param env - The interface to reference bindings declared in wrangler.jsonc
	 * @param ctx - The execution context of the Worker
	 * @returns The response to be sent back to the client
	 */
	async fetch(request, env, ctx): Promise<Response> {
		try {
			// Import router and proxy modules
			const { parseRoute } = await import('./router');
			const { proxyRequest } = await import('./proxy');

			// Parse request URL to extract route
			const url = new URL(request.url);
			const pathname = url.pathname;

			// Minimal public endpoints (avoid dashboards / stats / logging UIs)
			if (pathname === '/') {
				return new Response('BetterClaude Gateway. Use /claude/{host}/v1/messages', {
					status: 200,
					headers: { 'Content-Type': 'text/plain' },
				});
			}
			if (pathname === '/health') {
				return new Response('OK', {
					status: 200,
					headers: { 'Content-Type': 'text/plain' },
				});
			}

			// Parse request URL to extract route
			const route = parseRoute(url);

			// Validate route (return 400 if invalid or unrecognised path)
			if (!route) {
				return new Response(
					JSON.stringify({
						type: 'error',
						error: {
							type: 'invalid_request',
							message: 'Invalid endpoint. Use /claude/{host}/v1/messages',
						},
					}),
					{
						status: 400,
						headers: { 'Content-Type': 'application/json' },
					}
				);
			}

			// Proxy request to target API
			const proxyResult = await proxyRequest(request, route);

			return proxyResult.response;
		} catch (error) {
			// Catch proxy errors and return 502 (never expose internal details to client)
			return new Response('Bad Gateway', {
				status: 502,
				headers: { 'Content-Type': 'text/plain' },
			});
		}
	},
} satisfies ExportedHandler<Env>;
