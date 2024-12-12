import { WorkerEntrypoint } from "cloudflare:workers";
interface Env {
	ZOHO_TOKENS: KVNamespace;
	ZOHO_AUTH_DOMAIN: string;
	ZOHO_TOKEN_ENDPOINT: string;
	ZOHO_CLIENT_ID: string;
	ZOHO_CLIENT_SECRET: string;
	ZOHO_REDIRECT_URI: string;
	ZOHO_SCOPES: string;
}

interface ZohoTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	api_domain: string;
	token_type: string;
}

// Logging Helper Function
function log(level: 'info' | 'warn' | 'error', message: string, data?: any): void {
	const logEntry = {
		timestamp: new Date().toISOString(),
		level,
		message,
		data: data || {}
	};
	console[level](JSON.stringify(logEntry));
}

export default class ZohoOauthWorker extends WorkerEntrypoint {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const env = this.env as Env;
		log('info', "requested url", url)
		try {

			if (url.pathname === '/auth') {
				return handleAuth(env);
			} else if (url.pathname === '/oauth/callback') {
				return handleCallback(request, env);
			} else if (url.pathname === '/token') {
				log('info', "token called", url)
				return handleTokenRequest(env);
			} else {
				return new Response('Not Found', { status: 404 });
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error';
			log('error', 'Unhandled exception in fetch handler', { error: errorMessage });
			return new Response(JSON.stringify({ error: errorMessage }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}
	async getAccessToken(): Promise<string> {
		const env = this.env as Env
		const accessToken = await getValidAccessToken(env);
		return accessToken
	}
};

// OAuth Handlers
function handleAuth(env: Env): Response {
	log('info', 'handleAuth invoked');
	const authUrl = `https://${env.ZOHO_AUTH_DOMAIN}/oauth/v2/auth?` +
		`scope=${env.ZOHO_SCOPES}` +
		`client_id=${env.ZOHO_CLIENT_ID}&` +
		`response_type=code&` +
		`redirect_uri=${encodeURIComponent(env.ZOHO_REDIRECT_URI)}&` +
		`access_type=offline&` +
		`prompt=consent`;  // Force consent to get refresh token

	return Response.redirect(authUrl);
}

async function handleCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get('code');

	if (!code) {
		log('warn', 'Authorization code missing in callback');
		return new Response('Authorization code missing', { status: 400 });
	}

	try {
		const tokens = await getInitialTokens(code, env);
		log('info', 'Received tokens from Zoho', tokens);

		// Store tokens in KV
		await env.ZOHO_TOKENS.put('access_token', tokens.access_token);
		await env.ZOHO_TOKENS.put('refresh_token', tokens.refresh_token);
		await env.ZOHO_TOKENS.put('token_expiry', (Date.now() + tokens.expires_in * 1000).toString());

		log('info', 'Tokens stored successfully');
		return new Response('Authorization successful! You can close this window.');
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		log('error', 'Authorization failed during callback', { error: errorMessage });
		return new Response(`Authorization failed: ${errorMessage}`, { status: 500 });
	}
}

async function handleTokenRequest(env: Env): Promise<Response> {
	try {
		const accessToken = await getValidAccessToken(env);
		return new Response(JSON.stringify({ access_token: accessToken }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return new Response(JSON.stringify({ error: errorMessage }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

// Token Management
async function getInitialTokens(code: string, env: Env): Promise<ZohoTokenResponse> {
	log('info', 'Requesting initial tokens from Zoho');

	const response = await fetch(`https://${env.ZOHO_AUTH_DOMAIN}/oauth/v2/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			code,
			client_id: env.ZOHO_CLIENT_ID,
			client_secret: env.ZOHO_CLIENT_SECRET,
			redirect_uri: env.ZOHO_REDIRECT_URI,
			grant_type: 'authorization_code'
		})
	});

	log('info', 'Zoho token endpoint response received', { status: response.status });

	if (!response.ok) {
		log('error', 'Failed to obtain initial tokens from Zoho', { status: response.status, statusText: response.statusText });
		throw new Error(`Failed to get tokens: ${response.statusText}`);
	}

	const tokens: ZohoTokenResponse = await response.json();
	log('info', 'Initial tokens obtained from Zoho', { tokens: { access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in } });

	return tokens;
}

async function refreshAccessToken(refresh_token: string, env: Env): Promise<string> {
	log('info', 'Refreshing Zoho access token', { refresh_token });

	const response = await fetch(`https://${env.ZOHO_AUTH_DOMAIN}/oauth/v2/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			refresh_token,
			client_id: env.ZOHO_CLIENT_ID,
			client_secret: env.ZOHO_CLIENT_SECRET,
			grant_type: 'refresh_token'
		})
	});

	log('info', 'Zoho token refresh response received', { status: response.status });

	if (!response.ok) {
		log('error', 'Failed to refresh Zoho access token', { status: response.status, statusText: response.statusText });
		throw new Error(`Failed to refresh token: ${response.statusText}`);
	}

	const tokens: ZohoTokenResponse = await response.json();
	log('info', 'Access token refreshed successfully', { new_access_token: tokens.access_token });

	return tokens.access_token;
}

async function getValidAccessToken(env: Env): Promise<string> {
	log('info', 'Retrieving valid Zoho access token from KV');

	const [access_token, refresh_token, token_expiry] = await Promise.all([
		env.ZOHO_TOKENS.get('access_token'),
		env.ZOHO_TOKENS.get('refresh_token'),
		env.ZOHO_TOKENS.get('token_expiry')
	]);

	log('info', 'Fetched tokens from KV', { access_token: access_token ? 'exists' : 'missing', refresh_token: refresh_token ? 'exists' : 'missing', token_expiry });

	// If token is still valid, return it
	if (access_token && token_expiry && Date.now() < parseInt(token_expiry)) {
		log('info', 'Access token is still valid');
		return access_token;
	}

	// Otherwise refresh the token
	if (refresh_token) {
		log('info', 'Access token expired or missing. Attempting to refresh using refresh token');
		const newToken = await refreshAccessToken(refresh_token, env);
		await env.ZOHO_TOKENS.put('access_token', newToken);
		await env.ZOHO_TOKENS.put('token_expiry', (Date.now() + 3600 * 1000).toString()); // 1 hour expiry
		log('info', 'New access token stored in KV');
		return newToken;
	}

	log('error', 'No valid tokens available. Reauthorization required');
	throw new Error('No valid tokens available. Please reauthorize.');
}
