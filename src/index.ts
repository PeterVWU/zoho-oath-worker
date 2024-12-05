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
}

// const ZOHO_AUTH = {
// 	auth_domain: 'accounts.zoho.com',
// 	token_endpoint: '/oauth/v2/token',
// 	client_id: 'YOUR_CLIENT_ID',
// 	client_secret: 'YOUR_CLIENT_SECRET',
// 	redirect_uri: 'YOUR_REDIRECT_URI',
// 	scope: 'Desk.tickets.ALL'
// } as const;
interface ZohoTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
}

interface TokenResponse {
	access_token: string;
}



export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Handle initial OAuth authorization
		if (url.pathname === '/auth') {
			const authUrl = `https://${env.ZOHO_DESK_AUTH_DOMAIN}/oauth/v2/auth?` +
				`scope=${env.ZOHO_DESK_SCOPE}&` +
				`client_id=${env.ZOHO_DESK_CLIENT_ID}&` +
				`response_type=code&` +
				`redirect_uri=${env.ZOHO_DESK_REDIRECT_URI}&` +
				`access_type=offline`;

			return Response.redirect(authUrl);
		}

		// Handle OAuth callback
		if (url.pathname === '/oauth/callback') {
			const code = url.searchParams.get('code');
			if (!code) {
				return new Response('Authorization code missing', { status: 400 });
			}

			try {
				const tokens = await getInitialTokens(code, env);
				// Store tokens in KV
				await env.ZOHO_TOKENS.put('access_token', tokens.access_token);
				await env.ZOHO_TOKENS.put('refresh_token', tokens.refresh_token);
				await env.ZOHO_TOKENS.put('token_expiry', (Date.now() + tokens.expires_in * 1000).toString());

				return new Response('Authorization successful!');
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				return new Response(`Authorization failed: ${errorMessage}`, { status: 500 });
			}
		}

		// Get valid access token for API requests
		if (url.pathname === '/token') {
			try {
				const token = await getValidAccessToken(env.ZOHO_TOKENS, env);
				const response: TokenResponse = { access_token: token };
				return new Response(JSON.stringify(response), {
					headers: { 'Content-Type': 'application/json' }
				});
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : 'Unknown error';
				return new Response(`Token error: ${errorMessage}`, { status: 500 });
			}
		}

		return new Response('Not found', { status: 404 });
	}
} satisfies ExportedHandler<Env>;

async function getInitialTokens(code: string, env: Env): Promise<ZohoTokenResponse> {
	const response = await fetch(`https://${env.ZOHO_DESK_AUTH_DOMAIN}${env.ZOHO_DESK_TOKEN_ENDPOINT}`, {
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

async function refreshAccessToken(refresh_token: string, kv: KVNamespace, env: Env): Promise<string> {
	const response = await fetch(`https://${env.ZOHO_DESK_AUTH_DOMAIN}${env.ZOHO_DESK_TOKEN_ENDPOINT}`, {
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
	await kv.put('access_token', tokens.access_token);
	await kv.put('token_expiry', (Date.now() + tokens.expires_in * 1000).toString());

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
		return refreshAccessToken(refresh_token, kv, env);
	}

	throw new Error('No valid tokens available. Please reauthorize.');
}