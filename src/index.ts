interface Env {
	ZOHO_TOKENS: KVNamespace;
	ZOHO_DESK_AUTH_DOMAIN: string;
	ZOHO_DESK_TOKEN_ENDPOINT: string;
	ZOHO_DESK_CLIENT_ID: string;
	ZOHO_DESK_CLIENT_SECRET: string;
	ZOHO_DESK_REDIRECT_URI: string;
	ZOHO_DESK_SCOPE: string;
	ZOHO_DESK_DOMAIN: string;
	ZOHO_DESK_ORGID: string;

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
			log('error', 'Unhandled exception in fetch handler', { error: errorMessage });
			return new Response(JSON.stringify({ error: errorMessage }), {
				status: 500,
				headers: { 'Content-Type': 'application/json' }
			});
		}
	}
};

// OAuth Handlers
function handleAuth(env: Env): Response {
	log('info', 'handleAuth invoked');
	const authUrl = `https://${env.ZOHO_DESK_AUTH_DOMAIN}/oauth/v2/auth?` +
		`scope=Desk.tickets.ALL&` +
		`client_id=${env.ZOHO_DESK_CLIENT_ID}&` +
		`response_type=code&` +
		`redirect_uri=${encodeURIComponent(env.ZOHO_DESK_REDIRECT_URI)}&` +
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

// Ticket Handler
async function handleTicketCreation(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'POST') {
		log('warn', `Invalid request method: ${request.method}`);
		return new Response('Method not allowed', { status: 405 });
	}

	try {
		log('info', 'handleTicketCreation header', { headers: JSON.stringify(request.headers) })
		// Get ticket data from request
		const ticketData = await request.json() as TicketData;
		log('info', 'Received ticket data', { ticketData });

		// Get valid access token
		const accessToken = await getValidAccessToken(env.ZOHO_TOKENS, env);
		log('info', 'Retrieved valid Zoho access token');

		// Fetch or create contact using the phone number via CloudTalk
		// const contact = await getContactByPhoneCloudTalk(ticketData.phone, env);
		const contact: any = null;
		if (contact) {
			log('info', 'Contact found in CloudTalk', { contactId: contact.Contact.id });
		} else {
			log('info', 'No contact found in CloudTalk for the provided phone number');
		}

		let ticketDescription = "";
		if (contact) {
			// Fetch customer details from Magento
			const customerDetails = await getCustomerDetails(contact.ContactEmail.email, env);
			log('info', 'Fetched customer details from Magento', { email: contact.ContactEmail.email });

			// // Normalize phone numbers for comparison
			// const incomingPhone = normalizePhoneNumber(ticketData.phone);
			// const customerPhone = customerDetails ? normalizePhoneNumber(customerDetails.phone) : null;

			const orderHistory = await getOrderHistory(contact.ContactEmail.email, env);
			log('info', 'Fetched order history from Magento', { orderCount: orderHistory.length });

			// Create ticket description with customer and order info
			ticketDescription = createDetailedDescription(ticketData, customerDetails, orderHistory);

			// if (customerPhone && incomingPhone === customerPhone) {
			// 	log('info', 'Phone number matches with Magento customer');

			// 	// Fetch order history
			// 	const orderHistory = await getOrderHistory(contact.ContactEmail.email, env);
			// 	log('info', 'Fetched order history from Magento', { orderCount: orderHistory.length });

			// 	// Create ticket description with customer and order info
			// 	ticketDescription = createDetailedDescription(ticketData, customerDetails, orderHistory);
			// } else {
			// 	log('warn', 'Phone number mismatch between incoming phone and Magento customer', {
			// 		incomingPhone,
			// 		customerPhone
			// 	});
			// 	// Create ticket description without customer and order info
			// 	ticketDescription = createDetailedDescription(ticketData, null, []);
			// }
		} else {
			// Create ticket description without customer and order info
			ticketDescription = createDetailedDescription(ticketData, null, []);
		}

		// Create ticket in Zoho Desk
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
		log('info', 'Ticket created in Zoho Desk', { status: ticketResponse.status, responseData });

		return new Response(JSON.stringify(responseData), {
			status: ticketResponse.status,
			headers: { 'Content-Type': 'application/json' }
		});

	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : 'Unknown error';
		log('error', 'Error during ticket creation', { error: errorMessage });
		return new Response(JSON.stringify({ error: errorMessage }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' }
		});
	}
}

// Fetch contact by phone using CloudTalk API
async function getContactByPhoneCloudTalk(phone: string, env: Env): Promise<CloudTalkContact | null> {
	log('info', 'Fetching contact from CloudTalk', { phone });

	const url = `https://my.cloudtalk.io/api/contacts/index.json?keyword=${normalizePhoneNumber(phone)}`;

	const auth = btoa(`${env.CLOUDTALK_USERNAME}:${env.CLOUDTALK_PASSWORD}`);

	log('info', 'auth', auth);

	try {
		const response = await fetch(url, {
			method: 'GET',
			headers: {
				'Authorization': `Basic ${auth}`,
				'Content-Type': 'application/json'
			},
		});

		log('info', 'CloudTalk API response received', { status: response.status });

		if (response.ok) {
			const data: any = await response.json();
			if (data.responseData && data.responseData.data && data.responseData.data.length > 0) {
				// Assuming you want the first matching contact
				log('info', 'Contact found in CloudTalk', { contactCount: data.responseData.data.length });
				return data.responseData.data[0] as CloudTalkContact;
			}
		}

		log('warn', 'No contact found in CloudTalk for the provided phone number', { phone });
		return null;
	} catch (error: any) {
		if (error.name === 'AbortError') {
			log('error', 'CloudTalk API request timed out', { phone });
		} else {
			log('error', 'Error fetching contact from CloudTalk', { phone, error: error.message });
		}
		return null;
	}
}

// Fetch customer details from Magento
async function getCustomerDetails(email: string, env: Env): Promise<any> {
	log('info', 'Fetching customer details from Magento', { email });

	const response = await fetch(`${env.MAGENTO_API_URL}/customers/search?searchCriteria[filter_groups][0][filters][0][field]=email&searchCriteria[filter_groups][0][filters][0][value]=${encodeURIComponent(email)}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`, {
		headers: {
			'Authorization': `Bearer ${env.MAGENTO_API_TOKEN}`,
			'Content-Type': 'application/json'
		}
	});

	log('info', 'Magento API response received for customer details', { status: response.status });

	if (!response.ok) {
		log('error', 'Failed to fetch customer details from Magento', { status: response.status, statusText: response.statusText });
		throw new Error(`Failed to fetch customer details: ${response.statusText}`);
	}

	const data: any = await response.json();
	const customer = data.items?.[0] || null;

	if (customer) {
		log('info', 'Customer details retrieved from Magento', { customerId: customer.id });
	} else {
		log('warn', 'No customer details found in Magento for the provided email', { email });
	}

	return customer;
}

// Fetch order history from Magento
async function getOrderHistory(email: string, env: Env): Promise<any[]> {
	log('info', 'Fetching order history from Magento', { email });

	const response = await fetch(`${env.MAGENTO_API_URL}/orders?searchCriteria[filter_groups][0][filters][0][field]=customer_email&searchCriteria[filter_groups][0][filters][0][value]=${encodeURIComponent(email)}&searchCriteria[filter_groups][0][filters][0][condition_type]=eq`, {
		headers: {
			'Authorization': `Bearer ${env.MAGENTO_API_TOKEN}`,
			'Content-Type': 'application/json'
		}
	});

	log('info', 'Magento API response received for order history', { status: response.status });

	if (!response.ok) {
		log('error', 'Failed to fetch order history from Magento', { status: response.status, statusText: response.statusText });
		throw new Error(`Failed to fetch order history: ${response.statusText}`);
	}

	const data: any = await response.json();
	const orders = data.items || [];

	log('info', 'Order history retrieved from Magento', { orderCount: orders.length });

	return orders;
}

// Create detailed ticket description
function createDetailedDescription(ticketData: TicketData, customerDetails: any, orderHistory: any[]): string {
	log('info', 'Creating detailed ticket description', { ticketData, customerDetails, orderHistory });

	const descriptionArray = [];

	// Voicemail details
	descriptionArray.push(`<div><strong>Voicemail Recording:</strong> <a href="${ticketData.voicemailRecordingLink}">${ticketData.voicemailRecordingLink}</a></div>`);
	descriptionArray.push(`<div><strong>Voicemail Transcription:</strong> ${ticketData.voicemailTranscription}</div>`);

	if (customerDetails) {
		// Add the note about the accuracy of customer information
		descriptionArray.push(`<div style="color: orange; font-weight: bold;">Note: The following customer information is based on the provided phone number and may not be entirely accurate. Please verify the details.</div>`);

		// Customer details
		descriptionArray.push(`<div><strong>Customer Name:</strong> ${customerDetails.firstname} ${customerDetails.lastname}</div>`);
		descriptionArray.push(`<div><strong>Email:</strong> ${customerDetails.email}</div>`);
	}

	if (orderHistory.length > 0) {
		descriptionArray.push('<div><strong>Order History:</strong></div>');
		orderHistory.forEach(order => {
			descriptionArray.push(`<div>- <strong>Order ID:</strong> ${order.increment_id}, <strong>Total:</strong> ${order.grand_total}, <strong>Status:</strong> ${order.status}</div>`);
		});
	}

	return descriptionArray.join('<br/>');
}

// Normalize phone number by removing non-digit characters
function normalizePhoneNumber(phone: string): string {
	return phone.replace(/\D/g, '');
}

// Token Management
async function getInitialTokens(code: string, env: Env): Promise<ZohoTokenResponse> {
	log('info', 'Requesting initial tokens from Zoho');

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

	log('info', 'Zoho token refresh response received', { status: response.status });

	if (!response.ok) {
		log('error', 'Failed to refresh Zoho access token', { status: response.status, statusText: response.statusText });
		throw new Error(`Failed to refresh token: ${response.statusText}`);
	}

	const tokens: ZohoTokenResponse = await response.json();
	log('info', 'Access token refreshed successfully', { new_access_token: tokens.access_token });

	return tokens.access_token;
}

async function getValidAccessToken(kv: KVNamespace, env: Env): Promise<string> {
	log('info', 'Retrieving valid Zoho access token from KV');

	const [access_token, refresh_token, token_expiry] = await Promise.all([
		kv.get('access_token'),
		kv.get('refresh_token'),
		kv.get('token_expiry')
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
		await kv.put('access_token', newToken);
		await kv.put('token_expiry', (Date.now() + 3600 * 1000).toString()); // 1 hour expiry
		log('info', 'New access token stored in KV');
		return newToken;
	}

	log('error', 'No valid tokens available. Reauthorization required');
	throw new Error('No valid tokens available. Please reauthorize.');
}
