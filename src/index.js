// Configuration - these should be set as environment variables in Cloudflare Worker
const HASURA_ENDPOINT = globalThis.HASURA_ENDPOINT
const CACHE_TTL = globalThis.CACHE_TTL || 300 // Cache TTL in seconds (default: 5 minutes)
const MIN_CACHE_TTL = 8; // Minimum cache TTL in seconds
const JWT_PRIVATE_KEY = globalThis.JWT_PRIVATE_KEY // PEM-encoded RSA private key (PKCS#8) for signing JWTs; Hasura verifies with the matching public key
const WORKER_SHARED_SECRET = globalThis.WORKER_SHARED_SECRET // Pre-shared secret the calling backend must send in the X-Worker-Secret header

// Constant-time string comparison to avoid leaking the secret via timing
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false
    const aBytes = new TextEncoder().encode(a)
    const bBytes = new TextEncoder().encode(b)
    // Compare lengths in constant time by folding into the accumulator
    let mismatch = aBytes.length ^ bBytes.length
    const len = Math.max(aBytes.length, bBytes.length)
    for (let i = 0; i < len; i++) {
        mismatch |= (aBytes[i] || 0) ^ (bBytes[i] || 0)
    }
    return mismatch === 0
}

// Verify the inbound request carries the correct pre-shared secret.
// Fails closed: if no secret is configured, all requests are rejected.
function isAuthorized(request) {
    if (!WORKER_SHARED_SECRET) return false
    return timingSafeEqual(request.headers.get('X-Worker-Secret') || '', WORKER_SHARED_SECRET)
}

async function sha256(message) {
    // encode as UTF-8
    const msgBuffer = new TextEncoder().encode(message)
  
    // hash the message
    const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer)
  
    // convert ArrayBuffer to Array
    const hashArray = Array.from(new Uint8Array(hashBuffer))
  
    // convert bytes to hex string
    const hashHex = hashArray.map(b => ("00" + b.toString(16)).slice(-2)).join("")
    return hashHex
}
  
// Strip GraphQL string literals and comments so keyword detection can't be
// fooled by the word "mutation" appearing inside a string value or a comment.
function stripStringsAndComments(query) {
    return query
        .replace(/"""[\s\S]*?"""/g, '')   // block strings
        .replace(/"(?:\\.|[^"\\])*"/g, '') // double-quoted strings
        .replace(/#[^\n\r]*/g, '')         // line comments
}

// True if a single GraphQL document contains a mutation operation.
// A mutation always requires the `mutation` keyword (anonymous `{...}` is a
// query), so detecting that keyword at a definition boundary is sufficient.
function documentHasMutation(query) {
    if (typeof query !== 'string') return false
    const cleaned = stripStringsAndComments(query)
    // `mutation` keyword followed by a name, variable list `(`, or selection `{`
    return /\bmutation\b\s*[A-Za-z_({]/.test(cleaned)
}

// Determine whether a request should be blocked as a mutation.
// Handles batched (array) request bodies and fails open to "is a mutation"
// only when we can positively identify one — unparseable bodies are treated
// as non-mutations and forwarded (they will fail at Hasura if invalid).
async function blockMutation(req) {
    try {
        const body = await req.clone().json()
        const ops = Array.isArray(body) ? body : [body]
        return ops.some(op => op && documentHasMutation(op.query))
    } catch (e) {
        return false
    }
}

function pemToArrayBuffer(pem) {
    const b64 = pem
        .replace(/-----BEGIN [^-]+-----/, '')
        .replace(/-----END [^-]+-----/, '')
        .replace(/\s+/g, '')
    const binary = atob(b64)
    const buf = new ArrayBuffer(binary.length)
    const view = new Uint8Array(buf)
    for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i)
    return buf
}

let cachedSigningKey = null
async function getSigningKey() {
    if (cachedSigningKey) return cachedSigningKey
    cachedSigningKey = await crypto.subtle.importKey(
        'pkcs8',
        pemToArrayBuffer(JWT_PRIVATE_KEY),
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['sign']
    )
    return cachedSigningKey
}

// Generate JWT for Hasura authentication (RS256)
async function generateJWT() {
    const header = {
        alg: 'RS256',
        typ: 'JWT'
    }

    const payload = {
        sub: 'worker-user',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
        'https://hasura.io/jwt/claims': {
            'x-hasura-default-role': 'user',
            'x-hasura-allowed-roles': ['user'],
            'x-hasura-user-id': 'worker-user'
        }
    }

    const encodedHeader = btoa(JSON.stringify(header)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
    const encodedPayload = btoa(JSON.stringify(payload)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

    const data = encodedHeader + '.' + encodedPayload
    const key = await getSigningKey()
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data))

    const signatureArray = new Uint8Array(signature)
    const encodedSignature = btoa(String.fromCharCode(...signatureArray)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

    return data + '.' + encodedSignature
}

async function createHasuraRequest(originalRequest, body) {
    // Build a clean header set instead of forwarding arbitrary client headers.
    // This prevents callers from smuggling headers to Hasura (e.g. x-hasura-*
    // session variables or an admin secret). We add only what Hasura needs.
    const headers = new Headers()
    headers.set('Content-Type', 'application/json')

    // Preserve CORS preflight context so Hasura can answer OPTIONS correctly
    const corsHeaders = ['origin', 'access-control-request-method', 'access-control-request-headers']
    for (const name of corsHeaders) {
        const value = originalRequest.headers.get(name)
        if (value) headers.set(name, value)
    }

    // Add JWT authentication (overrides any client-supplied Authorization)
    if (JWT_PRIVATE_KEY) {
        const jwt = await generateJWT()
        headers.set('Authorization', `Bearer ${jwt}`)
    }

    return new Request(HASURA_ENDPOINT, {
        method: originalRequest.method,
        headers: headers,
        body: body
    })
}

// Create a cache key that includes TTL and query hash
async function createCacheKey(request, body) {
    const bodyHash = await sha256(body)
    
    // Include TTL in cache key to separate different TTL preferences
    const clientTTL = parseInt(request.headers.get('X-Cache-TTL'), 10) || MIN_CACHE_TTL
    const ttlContext = await sha256(`ttl-${clientTTL}`)
    
    const cacheUrl = new URL(request.url)
    cacheUrl.pathname = `${cacheUrl.pathname}/${ttlContext}/${bodyHash}`
    
    return new Request(cacheUrl.toString(), {
        method: "GET",
    })
}

async function handlePostRequest(event) {
    const request = event.request
    const body = await request.clone().text()

    // Get client TTL from header, fallback to minimum
    let clientTTL = parseInt(request.headers.get('X-Cache-TTL'), 10)
    if (isNaN(clientTTL) || clientTTL < MIN_CACHE_TTL) clientTTL = MIN_CACHE_TTL

    const isMutation = await blockMutation(request)
    
    // Hash the request body to use it as a part of the cache key
    if (!isMutation) {
        // Cache key = query body + requested TTL. The cache is global: every
        // request reaches Hasura as the same fixed worker identity, so all
        // callers share one cache. If per-caller identity passthrough is ever
        // added, the identity MUST be folded into this key to avoid leaking
        // one caller's data to another.
        const cacheKey = await createCacheKey(request, body)

        const cache = caches.default

        // Find the cache key in the cache
        let response = await cache.match(cacheKey)
        let cacheExpired = false

        // Check if cached response has expired
        if (response) {
            const cacheTime = response.headers.get('X-GQL-Cache-Time')
            // Use the TTL that was used when storing the cache (if present), otherwise use clientTTL
            const cacheTTL = parseInt(response.headers.get('X-Cache-TTL'), 10) || clientTTL
            if (cacheTime) {
            const ageInSeconds = Math.floor((Date.now() - parseInt(cacheTime)) / 1000)
            if (ageInSeconds > cacheTTL) {
                console.log(`Cache expired: ${ageInSeconds}s > ${cacheTTL}s TTL`)
                cacheExpired = true
                response = null // Treat as cache miss
            }
            }
        }

        // Otherwise, fetch response to POST request from origin
        if (!response) {
            // Create the Hasura request with proper headers and endpoint
            const hasuraRequest = await createHasuraRequest(request, body)
            const hasuraResponse = await fetch(hasuraRequest)
            
            response = new Response(hasuraResponse.body, hasuraResponse)
            response.headers.append('X-GQL-Cache-Time', `${new Date().getTime()}`)
            response.headers.append('X-Cache-Status', cacheExpired ? 'EXPIRED' : 'MISS')
            
            // Set cache TTL using Cache-Control header (for reference)
            response.headers.set('Cache-Control', `max-age=${clientTTL}`)
            response.headers.set('X-Cache-TTL', `${clientTTL}`)
            
            // Only cache successful responses
            if (response.status == 200)
                event.waitUntil(cache.put(cacheKey, response.clone()))
        } else {
            // Add cache hit indicator and age information
            const newResponse = new Response(response.body, response)
            newResponse.headers.append('X-Cache-Status', 'HIT')
            
            // Add cache age information
            const cacheTime = response.headers.get('X-GQL-Cache-Time')
            const cacheTTL = parseInt(response.headers.get('X-Cache-TTL'), 10) || clientTTL
            if (cacheTime) {
                const age = Math.floor((Date.now() - parseInt(cacheTime)) / 1000)
                newResponse.headers.append('X-Cache-Age', `${age}`)
                newResponse.headers.append('X-Cache-TTL', `${cacheTTL}`)
            }
            
            response = newResponse
        }
        return response
    } else {
        return new Response(JSON.stringify({
            errors: [{
            message: "Mutations are not allowed.",
            extensions: {
                code: "MUTATION_NOT_ALLOWED"
            }
            }]
        }), {
            status: 403,
            headers: {
                'Content-Type': 'application/json',
                'X-Cache-Status': 'BLOCKED'
            }
        })
    }
}

async function handleNonCachedRequest(request) {
    // Return 404 for non-cached requests (GET, etc.)
    return new Response('Not Found', { status: 404 })
}

async function handleOptionsRequest(request) {
    // Forward OPTIONS requests directly to Hasura (CORS preflight)
    const hasuraRequest = await createHasuraRequest(request, '')
    const response = await fetch(hasuraRequest)
    const newResponse = new Response(response.body, response)
    newResponse.headers.append('X-Cache-Status', 'OPTIONS')
    return newResponse
}

function unauthorizedResponse() {
    return new Response(JSON.stringify({
        errors: [{
            message: "Unauthorized.",
            extensions: { code: "UNAUTHORIZED" }
        }]
    }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
    })
}

addEventListener("fetch", event => {
    try {
        const request = event.request
        const url = new URL(request.url)

        // Gate every request on the pre-shared secret (fails closed)
        if (!isAuthorized(request)) {
            return event.respondWith(unauthorizedResponse())
        }

        // Handle GraphQL requests with caching
        if (url.pathname === '/v1/graphql' && request.method.toUpperCase() === "POST") { //&& request.headers.get('X-Skip-Cache') != '1') {
            return event.respondWith(handlePostRequest(event))
        }

        // Forward OPTIONS requests directly to Hasura (CORS preflight)
        if (request.method.toUpperCase() === "OPTIONS") {
            return event.respondWith(handleOptionsRequest(request))
        }

        return event.respondWith(handleNonCachedRequest(request))
    } catch (e) {
        console.log(e.message)
        return event.respondWith(new Response(JSON.stringify({
            errors: [{ message: "Internal error.", extensions: { code: "INTERNAL_ERROR" } }]
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        }))
    }
})
