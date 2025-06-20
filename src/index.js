// Configuration - these should be set as environment variables in Cloudflare Worker
const HASURA_ENDPOINT = globalThis.HASURA_ENDPOINT
const ALLOWED_IPS = globalThis.ALLOWED_IPS // Comma-separated list of allowed IPs/CIDR blocks for webhook calls
const HASURA_K8S_CLUSTER_IP = globalThis.HASURA_K8S_CLUSTER_IP // IP range of your K8s cluster (e.g., "10.0.0.0/8")
const CACHE_TTL = globalThis.CACHE_TTL || 300 // Cache TTL in seconds (default: 5 minutes)
const MIN_CACHE_TTL = 8; // Minimum cache TTL in seconds

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
  
async function blockMutation(req) {
    try {
        const body = await req.clone().json()
        console.log(body.query.replace(/\s/g, '').indexOf("mutation"))
        return body.query.replace(/\s/g, '').indexOf("mutation") == 0
    } catch (e) {
        return false
    }
}

// Check if IP is in allowed range
function isIPAllowed(ip) {
    if (!ALLOWED_IPS && !HASURA_K8S_CLUSTER_IP) {
        // If no IP restrictions configured, allow all (development mode)
        return true
    }

    // Check against specific allowed IPs
    if (ALLOWED_IPS) {
        const allowedList = ALLOWED_IPS.split(',').map(ip => ip.trim())
        if (allowedList.includes(ip)) {
        return true
        }
    }

    // Check against K8s cluster IP range
    if (HASURA_K8S_CLUSTER_IP && ip) {
        // Simple check for common K8s internal IP ranges
        if (HASURA_K8S_CLUSTER_IP.includes('/')) {
        // CIDR notation (e.g., "10.0.0.0/8")
        const [network, prefix] = HASURA_K8S_CLUSTER_IP.split('/')
        // For production, you'd want a proper CIDR matching library
        // This is a simplified check for common patterns
        if (network.startsWith('10.') && ip.startsWith('10.')) return true
        if (network.startsWith('172.') && ip.startsWith('172.')) return true
        if (network.startsWith('192.168.') && ip.startsWith('192.168.')) return true
        } else {
        // Single IP
        return ip === HASURA_K8S_CLUSTER_IP
        }
    }

    return false
}

// Auth webhook endpoint - Hasura calls this to validate requests
async function handleAuthWebhook(request) {
    try {
        // Get the real IP address from Cloudflare headers
        const clientIP = request.headers.get('CF-Connecting-IP') || 
                        request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
                        request.headers.get('X-Real-IP')
        
        console.log('Auth webhook called from IP:', clientIP)
        
        // Validate IP if restrictions are configured
        if (!isIPAllowed(clientIP)) {
        console.log(`Webhook call rejected from IP: ${clientIP}`)
        return new Response('Forbidden - Invalid source IP', { status: 403 })
        }
        
        // Parse headers from query parameters (Hasura sends them as URL params)
        const url = new URL(request.url)
        const headers = {}
        
        // Hasura sends headers as query parameters
        for (const [key, value] of url.searchParams.entries()) {
        headers[key.toLowerCase()] = value
        }
        
        console.log('Auth webhook called with headers:', Object.keys(headers))
        
        // Simple role assignment - customize this based on your needs
        let role = 'user'
        
        // Return session variables for Hasura
        const response = {
        'X-Hasura-Role': role,
        }
        
        console.log('Auth webhook response:', response)
        return new Response(JSON.stringify(response), {
        headers: { 'Content-Type': 'application/json' }
        })
        
    } catch (error) {
        console.error('Auth webhook error:', error)
        return new Response(JSON.stringify({ 
        'X-Hasura-Role': 'anonymous',
        }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
        })
    }
}

async function createHasuraRequest(originalRequest, body) {
    // Create headers for Hasura request
    const headers = new Headers(originalRequest.headers)

    // Ensure content-type is set for GraphQL
    headers.set('Content-Type', 'application/json')

    // Remove headers that shouldn't be forwarded
    headers.delete('host')
    headers.delete('cf-ray')
    headers.delete('cf-connecting-ip')
    headers.delete('cf-visitor')
    headers.delete('x-forwarded-proto')
    headers.delete('x-real-ip')

    // Keep auth headers - Hasura will call our webhook to validate them

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
        headers: request.headers,
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
    // Create cache key that includes user authentication context
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
    // Allow mutations but don't cache them - forward to Hasura
    const hasuraRequest = await createHasuraRequest(request, body)
    const response = await fetch(hasuraRequest)
    const newResponse = new Response(response.body, response)
    newResponse.headers.append('X-Cache-Status', 'MUTATION')
    return newResponse
    }
}

async function handleNonCachedRequest(request) {
    // Return 404 for non-cached requests (GET, etc.)
    return new Response('Not Found', { status: 404 })
}

addEventListener("fetch", event => {
    try {
    const request = event.request
    const url = new URL(request.url)
    
    // Handle auth webhook endpoint (Hasura uses GET requests)
    if (url.pathname === '/auth' && request.method === 'GET') {
        return event.respondWith(handleAuthWebhook(request))
    }
    
    // Handle GraphQL requests with caching
    if (url.pathname === '/v1/graphql' && request.method.toUpperCase() === "POST") { //&& request.headers.get('X-Skip-Cache') != '1') {
        return event.respondWith(handlePostRequest(event))
    }
    
    return event.respondWith(handleNonCachedRequest(request))
    } catch (e) {
    console.log(e.message)
    return event.respondWith(new Response("Error thrown " + e.message))
    }
}) 