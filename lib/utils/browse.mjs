import { request as undicireq } from "undici";
import { Cookie, CookieJar } from "tough-cookie";
import { createBrotliDecompress, createInflate, createGunzip } from "node:zlib";
import { Camoufox } from 'camoufox-js';

class StatusCodeError extends Error {
    constructor(message, statusCode) {
        super(message);
        this["name"] = this.constructor.name;
        this["statusCode"] = statusCode;
        Error.captureStackTrace(this, this.constructor);
    }
}

class BROWSE {
    constructor(options = {}) {
        this.cookiejar = new CookieJar();
        this.maxRedirections = options.maxRedirections || 5;
        this.redirectcount = 0;
        this.browser = null;
        this.context = null;
        this.page = null;
    }

    async initCamoufox() {
        if (!this.browser) {
            this.browser = await Camoufox({ humanize: true, headless:true });
            this.context = await this.browser.newContext();
            this.page = await this.context.newPage();
            
            // Keep browser alive during the entire session
            console.log('Browser session started - keeping alive for entire booking process');
        }
    }

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
            this.page = null;
            console.log('Browser session closed');
        }
    }

    async getcookies(url, headers) {
        const cookies = await this.cookiejar.getCookies(url);
        if (cookies && cookies.length) {
            headers["Cookie"] = cookies.map(cookie => cookie.cookieString()).join(';');
        }
    }

    async setcookies(url, headers) {
        if (headers && Object.prototype.hasOwnProperty.call(headers, "set-cookie")) {
            const cookies = Array.isArray(headers["set-cookie"]) ? headers["set-cookie"].map(Cookie.parse) : [Cookie.parse(headers["set-cookie"])];
            for (let cookie of cookies) {
                this.cookiejar.setCookie(cookie, url);
            };
        };
    }

    async converttobuffer(body) {
        let data = [];
        for await (const chunk of body) {
            data.push(chunk);
        }
        return Buffer.concat(data);
    }

    async handlebody(headers, body) {
        if (headers && Object.prototype.hasOwnProperty.call(headers, "content-encoding") && ['gzip', 'deflate', 'br'].includes(headers['content-encoding'])) {
            if (headers["content-encoding"] === "br") {
                return body.pipe(createBrotliDecompress());
            } else if (headers["content-encoding"] === "gzip") {
                return body.pipe(createGunzip());
            } else if (headers["content-encoding"] === "deflate") {
                return body.pipe(createInflate());
            }
        }
        return body;
    }

    async request(url, options = {}) {
        await this.initCamoufox();

        if (!Object.prototype.hasOwnProperty.call(options, "headers")) {
            options.headers = {};
        }
        options.headers["Host"] = new URL(url).hostname;
        await this.getcookies(url, options.headers);

        console.log('=== REQUEST DEBUG ===');
        console.log('URL:', url);
        // console.log('Method:', options.method || 'GET');
        // console.log('Headers:', JSON.stringify(options.headers, null, 2));
        // console.log('Body:', options.body);

        // Set headers on the page (filter out problematic headers)
        const cleanHeaders = { ...options.headers };
        delete cleanHeaders['Host']; // Let browser handle Host header
        delete cleanHeaders['Content-Length']; // Let browser calculate
        await this.page.setExtraHTTPHeaders(cleanHeaders);

        let response;
        const method = options.method || 'GET';
        const isPaymentGateway = url.includes('wps.irctc.co.in') || url.includes('paytm');

        if (method === 'GET') {
            response = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
        } else if (isPaymentGateway) {
            // For payment gateway requests, use page navigation with form submission
            response = await this.handlePaymentNavigation(url, options);
        } else {
            // For POST requests, use page.evaluate to make the request within browser context
            response = await this.page.evaluate(async ({ url, method, headers, body }) => {
                const fetchOptions = {
                    method: method,
                    headers: headers,
                    credentials: 'include' // Include cookies
                };

                if (body) {
                    if (typeof body === 'object') {
                        const contentType = headers['Content-Type'] || headers['content-type'] || '';
                        if (contentType.includes('application/json')) {
                            fetchOptions.body = JSON.stringify(body);
                        } else if (contentType.includes('application/x-www-form-urlencoded')) {
                            fetchOptions.body = new URLSearchParams(body).toString();
                        } else {
                            // Default to JSON for object bodies
                            fetchOptions.body = JSON.stringify(body);
                            if (!contentType) {
                                fetchOptions.headers['Content-Type'] = 'application/json';
                            }
                        }
                    } else {
                        fetchOptions.body = body;
                    }
                }

                try {
                    const response = await fetch(url, fetchOptions);
                    const text = await response.text();
                    
                    let data;
                    const contentType = response.headers.get('content-type') || '';
                    if (contentType.includes('application/json')) {
                        try {
                            data = JSON.parse(text);
                        } catch {
                            data = text;
                        }
                    } else {
                        data = text;
                    }

                    // Extract headers using a more reliable method
                    const headersObj = {};
                    try {
                        // Try the standard way first
                        if (response.headers && response.headers.forEach) {
                            response.headers.forEach((value, key) => {
                                headersObj[key] = value;
                            });
                        } else {
                            // Fallback: extract common headers manually
                            const commonHeaders = [
                                'content-type', 'content-length', 'set-cookie', 'csrf-token', 
                                'authorization', 'cache-control', 'expires', 'location'
                            ];
                            for (const header of commonHeaders) {
                                const value = response.headers.get(header);
                                if (value) {
                                    headersObj[header] = value;
                                }
                            }
                        }
                    } catch (headerError) {
                        console.warn('Header extraction failed:', headerError.message);
                        // Try to get at least the essential headers
                        try {
                            headersObj['content-type'] = response.headers.get('content-type') || '';
                            headersObj['csrf-token'] = response.headers.get('csrf-token') || '';
                        } catch {}
                    }

                    return {
                        status: response.status,
                        headers: headersObj,
                        body: data,
                        ok: response.ok
                    };
                } catch (error) {
                    return {
                        status: 0,
                        headers: {},
                        body: { error: error.message },
                        ok: false
                    };
                }
            }, { url, method, headers: options.headers, body: options.body });
        }

        let data, headers, statusCode;

        if (method === 'GET') {
            statusCode = response.status();
            headers = response.headers();
            
            const contentType = headers['content-type'] || '';
            if (contentType.includes('application/json')) {
                try {
                    const text = await this.page.content();
                    // Try to extract JSON from page content
                    const jsonMatch = text.match(/<pre[^>]*>([^<]+)<\/pre>/);
                    if (jsonMatch) {
                        data = JSON.parse(jsonMatch[1]);
                    } else {
                        // Try to get JSON from page evaluation
                        data = await this.page.evaluate(() => {
                            try {
                                return JSON.parse(document.body.textContent || document.body.innerText);
                            } catch {
                                return document.body.textContent || document.body.innerText;
                            }
                        });
                    }
                } catch {
                    data = await this.page.content();
                }
            } else {
                data = await this.page.content();
            }
        } else {
            statusCode = response.status;
            headers = response.headers;
            data = response.body;
            
            // Handle fetch errors
            if (!response.ok && response.status === 0) {
                throw new StatusCodeError(`Network request failed: ${data.error || 'Unknown error'}`, 500);
            }
            
            // Ensure we have valid headers object
            if (!headers || typeof headers !== 'object') {
                headers = {};
            }
        }

        await this.setcookies(url, headers);

        console.log('=== RESPONSE DEBUG ===');
        console.log('Status:', statusCode);
        console.log('Headers:', JSON.stringify(headers, null, 2));
        console.log('Body:', typeof data === 'string' ? data.substring(0, 1000) + (data.length > 1000 ? '...' : '') : data);
        console.log('=====================');

        if (statusCode >= 400) {
            throw new StatusCodeError(`Request failed with status code ${statusCode}`, statusCode);
        }

        return {
            statusCode: statusCode,
            headers: headers,
            body: data
        };
    }

    async handlePaymentNavigation(url, options) {
        // Use the original context.request.fetch method for PaymentRedirect
        const fetchOptions = {
            method: options.method || 'POST',
            headers: options.headers
        };
        
        if (options.body) {
            if (typeof options.body === 'object' && options.headers['Content-Type']) {
                if (options.headers['Content-Type'].startsWith('application/x-www-form-urlencoded')) {
                    fetchOptions.data = new URLSearchParams(options.body).toString();
                } else {
                    fetchOptions.data = JSON.stringify(options.body);
                }
            } else {
                fetchOptions.data = options.body;
            }
        }
        
        const response = await this.context.request.fetch(url, fetchOptions);
        
        const headers = response.headers();
        let data;
        const contentType = headers['content-type'] || '';
        if (contentType.includes('application/json')) {
            try {
                data = await response.json();
            } catch {
                data = await response.text();
            }
        } else {
            data = await response.text();
        }
        
        return {
            status: response.status(),
            headers: headers,
            body: data,
            ok: response.status() < 400
        };
    }
}
export { BROWSE, StatusCodeError };
export default BROWSE;
