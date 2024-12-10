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

	MAGENTO_API_URL: string;
	MAGENTO_API_TOKEN: string;

	CLOUDTALK_USERNAME: string;
	CLOUDTALK_PASSWORD: string;
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
	contactId?: string;
	phone: string;
	voicemailRecordingLink: string;
	voicemailTranscription: string;
	[key: string]: unknown;
}


interface CloudTalkContact {
	Contact: {
		id: string;
		name: string;
		company: string;
	};
	ContactNumber: {
		public_number: number;
	};
	ContactEmail: {
		email: string;
	};
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

		const contact = await getContactByPhoneCloudTalk(ticketData.phone, env);

		let ticketDescription = ""
		if (contact) {

			// Fetch customer details and order history from Magento
			const customerDetails = await getCustomerDetails(contact.ContactEmail.email, env);
			const orderHistory = await getOrderHistory(contact.ContactEmail.email, env);
			// Create ticket description
			ticketDescription = createDetailedDescription(ticketData, customerDetails, orderHistory);
		} else {
			ticketDescription = createDetailedDescription(ticketData, null, []);

		}

		// Create ticket
		const ticketResponse = await fetch(`https://${env.ZOHO_DESK_DOMAIN}/api/v1/tickets`, {
			method: 'POST',
			headers: {
				'orgId': env.ZOHO_DESK_ORGID,
				'Authorization': `Zoho-oauthtoken ${accessToken}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				subject: ticketData.subject,
				phone: ticketData.phone,
				departmentId: ticketData.departmentId,
				contactId: ticketData.contactId,
				description: ticketDescription
			})
		});

		const responseData = await ticketResponse.json();
		console.log('ticketResponse.status', ticketResponse.status)
		console.log('ticketData', JSON.stringify(ticketData))
		return new Response(JSON.stringify(responseData), {
			status: ticketResponse.status,
			headers: { 'Content-Type': 'application/json' }
		});

	} catch (error) {
		console.log('ticketResponse.error', JSON.stringify(error))
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		return new Response(JSON.stringify({ error: errorMessage }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

// Fetch contact by phone using CloudTalk API
async function getContactByPhoneCloudTalk(phone: string, env: Env): Promise<CloudTalkContact | null> {
	console.log("getContactByPhoneCloudTalk", phone);

	const url = `https://my.cloudtalk.io/api/contacts/index.json?keyword=${encodeURIComponent(phone)}`;

	const auth = btoa(`${env.CLOUDTALK_USERNAME}:${env.CLOUDTALK_PASSWORD}`);

	const response = await fetch(url, {
		method: 'GET',
		headers: {
			'Authorization': `Basic ${auth}`,
			'Content-Type': 'application/json'
		}
	});

	console.log("getContactByPhoneCloudTalk response status:", response.status);

	if (response.ok) {
		const data: any = await response.json();
		if (data.responseData && data.responseData.data && data.responseData.data.length > 0) {
			// Assuming you want the first matching contact
			return data.responseData.data[0] as CloudTalkContact;
		}
	}

	console.error("No contact found in CloudTalk for phone:", phone);
	return null;
}


// Fetch customer details from Magento
async function getCustomerDetails(email: string, env: Env): Promise<any> {
	console.log("getCustomerDetails", email)
	const response = await fetch(`${env.MAGENTO_API_URL}/customers/search?searchCriteria[filter_groups][0][filters][0][field]=email&searchCriteria[filter_groups][0][filters][0][value]=${encodeURIComponent(email)}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`, {
		headers: {
			'Authorization': `Bearer ${env.MAGENTO_API_TOKEN}`,
			'Content-Type': 'application/json'
		}
	});

	console.log("getCustomerDetails response", response)
	if (!response.ok) {
		throw new Error(`Failed to fetch customer details: ${response.statusText}`);
	}

	const data: any = await response.json();
	return data.items?.[0] || null;
}

// Fetch order history from Magento
async function getOrderHistory(email: string, env: Env): Promise<any[]> {
	console.log("getOrderHistory", email)
	const response = await fetch(`${env.MAGENTO_API_URL}/orders?searchCriteria[filter_groups][0][filters][0][field]=customer_email&searchCriteria[filter_groups][0][filters][0][value]=${encodeURIComponent(email)}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`, {
		headers: {
			'Authorization': `Bearer ${env.MAGENTO_API_TOKEN}`,
			'Content-Type': 'application/json'
		}
	});

	console.log("getOrderHistory", response)
	if (!response.ok) {
		throw new Error(`Failed to fetch order history: ${response.statusText}`);
	}

	const data: any = await response.json();
	return data.items || [];
}

// Create detailed ticket description
function createDetailedDescription(ticketData: TicketData, customerDetails: any, orderHistory: any[]): string {
	console.log("createDetailedDescription", ticketData, customerDetails, orderHistory)
	const descriptionArray = [];

	descriptionArray.push(`<div>Voicemail Recording: <a href="${ticketData.voicemailRecordingLink}">${ticketData.voicemailRecordingLink}</a></div>`);
	descriptionArray.push(`<div>Voicemail Transcription: ${ticketData.voicemailTranscription}</div>`);

	if (customerDetails) {
		descriptionArray.push(`<div style="color: orange; font-weight: bold;">Note: The following customer information is based on the provided phone number and may not be entirely accurate. Please verify the details.</div>`);

		descriptionArray.push(`<div>Customer Name: ${customerDetails.firstname} ${customerDetails.lastname}</div>`);
		descriptionArray.push(`<div>Email: ${customerDetails.email}</div>`);
	}

	if (orderHistory.length > 0) {
		descriptionArray.push('<div>Order History:</div>');
		orderHistory.forEach(order => {
			descriptionArray.push(`<div>- Order ID: ${order.increment_id}, Total: ${order.grand_total}, Status: ${order.status}</div>`);
		});
	}

	return descriptionArray.join('</br>');
}

// Token Management
async function getInitialTokens(code: string, env: Env): Promise<ZohoTokenResponse> {
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