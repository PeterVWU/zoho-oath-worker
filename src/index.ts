/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

interface Env {
	ZOHO_TOKENS: KVNamespace;
	ZOHO_DESK_AUTH_DOMAIN: string;
	ZOHO_DESK_TOKEN_ENDPOINT: string;
	ZOHO_DESK_CLIENT_ID: string;
	ZOHO_DESK_CLIENT_SECRET: string;
	ZOHO_DESK_REDIRECT_URI: string;
	ZOHO_DESK_SCOPE: string;
	ZOHO_DESK_DOMAIN: string,
	ZOHO_DESK_ORGID: string,
}

interface ZohoTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	api_domain: string;
	token_type: string;
}

interface TokenResponse {
	access_token: string;
}

interface TicketData {
	subject: string;
	departmentId: string;
	description: string;
	contactId?: string;
	[key: string]: unknown;
}


export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			// OAuth routes
			if (url.pathname === '/auth') {
				return handleAuth(env);
			}

			if (url.pathname === '/oauth/callback') {
				return handleCallback(request, env);
			}

			// Ticket creation route
			if (url.pathname === '/tickets') {
				return handleTicketCreation(request, env);
			}

			return new Response('Not found', { status: 404 });
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			return new Response(JSON.stringify({ error: errorMessage }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}
};

// OAuth Handlers
function handleAuth(env: Env): Response {
	console.log('handleAuth')
	const authUrl = `https://${env.ZOHO_DESK_AUTH_DOMAIN}/oauth/v2/auth?` +
		`scope=Desk.tickets.ALL&` +
		`client_id=${env.ZOHO_DESK_CLIENT_ID}&` +
		`response_type=code&` +
		`redirect_uri=${env.ZOHO_DESK_REDIRECT_URI}&` +
		`access_type=offline&` +
		`prompt=consent`;  // Force consent to get refresh token

	return Response.redirect(authUrl);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get('code');
	console.log('code', code)

	if (!code) {
		return new Response('Authorization code missing', { status: 400 });
	}

	try {
		const tokens = await getInitialTokens(code, env);
		console.log('tokens', tokens)
		// Store tokens in KV
		await env.ZOHO_TOKENS.put('access_token', tokens.access_token);
		await env.ZOHO_TOKENS.put('refresh_token', tokens.refresh_token);
		await env.ZOHO_TOKENS.put('token_expiry', (Date.now() + tokens.expires_in * 1000).toString());

		return new Response('Authorization successful! You can close this window.');
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return new Response(`Authorization failed: ${errorMessage}`, { status: 500 });
	}
}

// Ticket Handler
async function handleTicketCreation(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}

	try {
		// Get ticket data from request
		const ticketData = await request.json() as TicketData;

		// Get valid access token
		const accessToken = await getValidAccessToken(env.ZOHO_TOKENS, env);

		// Create ticket
		const ticketResponse = await fetch(`https://${env.ZOHO_DESK_DOMAIN}/api/v1/tickets`, {
			method: 'POST',
			headers: {
				'orgId': env.ZOHO_DESK_ORGID,
				'Authorization': `Zoho-oauthtoken ${accessToken}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify(ticketData)
		});

		const responseData = await ticketResponse.json();

		return new Response(JSON.stringify(responseData), {
			status: ticketResponse.status,
			headers: { 'Content-Type': 'application/json' }
		});

	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return new Response(JSON.stringify({ error: errorMessage }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

// Token Management
async function getInitialTokens(code: string, env: Env): Promise<ZohoTokenResponse> {
	console.log('getInitialTokens env.ZOHO_DESK_CLIENT_ID', env.ZOHO_DESK_CLIENT_ID)
	console.log('getInitialTokens env.ZOHO_DESK_CLIENT_SECRET', env.ZOHO_DESK_CLIENT_SECRET)
	console.log('getInitialTokens env.ZOHO_DESK_REDIRECT_URI', env.ZOHO_DESK_REDIRECT_URI)
	const response = await fetch(`https://${env.ZOHO_DESK_AUTH_DOMAIN}/oauth/v2/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: env.ZOHO_DESK_CLIENT_ID,
			client_secret: env.ZOHO_DESK_CLIENT_SECRET,
			redirect_uri: env.ZOHO_DESK_REDIRECT_URI,
			grant_type: 'authorization_code'
		})
	});

	if (!response.ok) {
		throw new Error(`Failed to get tokens: ${response.statusText}`);
	}

	return response.json();
}

async function refreshAccessToken(refresh_token: string, env: Env): Promise<string> {
	const response = await fetch(`https://${env.ZOHO_DESK_AUTH_DOMAIN}/oauth/v2/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			refresh_token,
			client_id: env.ZOHO_DESK_CLIENT_ID,
			client_secret: env.ZOHO_DESK_CLIENT_SECRET,
			grant_type: 'refresh_token'
		})
	});

	if (!response.ok) {
		throw new Error(`Failed to refresh token: ${response.statusText}`);
	}

	const tokens: ZohoTokenResponse = await response.json();
	return tokens.access_token;
}

async function getValidAccessToken(kv: KVNamespace, env: Env): Promise<string> {
	const [access_token, refresh_token, token_expiry] = await Promise.all([
		kv.get('access_token'),
		kv.get('refresh_token'),
		kv.get('token_expiry')
	]);

	// If token is still valid, return it
	if (access_token && token_expiry && Date.now() < parseInt(token_expiry)) {
		return access_token;
	}

	// Otherwise refresh the token
	if (refresh_token) {
		const newToken = await refreshAccessToken(refresh_token, env);
		await kv.put('access_token', newToken);
		await kv.put('token_expiry', (Date.now() + 3600 * 1000).toString()); // 1 hour expiry
		return newToken;
	}

	throw new Error('No valid tokens available. Please reauthorize.');
}