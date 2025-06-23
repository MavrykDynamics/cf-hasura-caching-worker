# Hasura Cache Worker

A Cloudflare Worker that acts as a caching layer for Hasura GraphQL API with JWT authentication.

## Features

- **JWT Authentication**: Uses JWT tokens with user role for secure access to Hasura
- **Intelligent Caching**: Caches GraphQL queries with configurable TTL
- **Client TTL Control**: Clients can specify cache TTL via `X-Cache-TTL` header
- **Cache Headers**: Returns cache status and age information
- **Multi-Environment Support**: Deploy to multiple environments with different Hasura endpoints

## Setup

### 1. Configure Hasura for JWT

Set the JWT secret in your Hasura environment:
```bash
HASURA_GRAPHQL_JWT_SECRET='{"type":"HS256","key":"your-secret-key-here"}'
```

### 2. Deploy the Worker

```bash
# Install dependencies
npm install

# Deploy to production
wrangler deploy

# Deploy to specific environment
wrangler deploy --env maven
wrangler deploy --env equiteez
```

### 3. Set Secrets

```bash
# Set JWT secret (must match Hasura's JWT_SECRET)
wrangler secret put JWT_SECRET

# Set optional cache TTL
wrangler secret put CACHE_TTL
```

## Configuration

### Environment Variables

- `HASURA_ENDPOINT`: Your Hasura GraphQL endpoint
- `JWT_SECRET`: Secret for signing JWTs (must match Hasura's JWT_SECRET)
- `CACHE_TTL`: Default cache TTL in seconds (default: 300)

### Client Headers

- `X-Cache-TTL`: Override cache TTL for this request (minimum: 8 seconds)
- `X-Skip-Cache`: Set to "1" to bypass cache

### Response Headers

- `X-Cache-Status`: "HIT", "MISS", or "SKIP"
- `X-Cache-Age`: Age of cached response in seconds

## How It Works

1. **JWT Generation**: Worker generates JWT tokens with user role permissions
2. **Request Forwarding**: Forwards GraphQL requests to Hasura with JWT authentication
3. **Caching**: Caches responses based on query hash and TTL
4. **Cache Control**: Respects client-specified TTL with minimum enforcement

## Security

- Uses JWT authentication with user role (not admin)
- JWT tokens expire after 1 hour
- No admin access required
- Secure token signing with HMAC-SHA256

## Multi-Environment Deployment

The worker supports multiple environments with different Hasura endpoints:

```bash
# Deploy to Maven environment
wrangler deploy --env maven

# Deploy to Equiteez environment  
wrangler deploy --env equiteez
```

Each environment has its own:
- Worker name
- Hasura endpoint
- Secrets (JWT_SECRET, CACHE_TTL)

## Quick Start

### 1. Clone and Install

```bash
git clone <your-repo>
cd hasura-cache-worker
npm install
```

### 2. Configure Environment

Edit `wrangler.toml` to set your Hasura endpoint:

```toml
[vars]
HASURA_ENDPOINT = "https://your-hasura-api.com/v1/graphql"
```

### 3. Set Secrets (Optional)

```bash
# For IP restrictions
wrangler secret put ALLOWED_IPS
wrangler secret put HASURA_K8S_CLUSTER_IP

# For custom default TTL
wrangler secret put CACHE_TTL
```

### 4. Deploy

```bash
# Development
npm run dev

# Production
npm run deploy:production
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `HASURA_ENDPOINT` | Your Hasura GraphQL endpoint | Required |
| `ALLOWED_IPS` | Comma-separated list of allowed IPs | None (allow all) |
| `HASURA_K8S_CLUSTER_IP` | K8s cluster IP range (e.g., "10.0.0.0/8") | None |
| `CACHE_TTL` | Default cache TTL in seconds | 300 (5 minutes) |

### Hasura Configuration

Set your Hasura environment variable:

```bash
HASURA_GRAPHQL_AUTH_HOOK=https://your-worker.workers.dev/auth
```

## Usage

### Basic GraphQL Query

```javascript
fetch('https://your-worker.workers.dev', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your-token'
  },
  body: JSON.stringify({
    query: '{ dipdup_head { level } }'
  })
});
```

### Custom Cache TTL

```javascript
fetch('https://your-worker.workers.dev', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Cache-TTL': '60'  // Cache for 60 seconds
  },
  body: JSON.stringify({
    query: '{ users { id name } }'
  })
});
```

## Cache Headers

### Response Headers

| Header | Description |
|--------|-------------|
| `X-Cache-Status` | `MISS`, `HIT`, `EXPIRED`, or `MUTATION` |
| `X-Cache-Age` | Age of cached response in seconds |
| `X-Cache-TTL` | TTL used for this response |
| `X-GQL-Cache-Time` | Timestamp when response was cached |

### Example Response

```json
{
  "data": {
    "dipdup_head": [
      {
        "level": 123456
      }
    ]
  }
}
```

With headers:
```
X-Cache-Status: HIT
X-Cache-Age: 45
X-Cache-TTL: 300
X-GQL-Cache-Time: 1640995200000
```

## Authentication

The worker supports webhook authentication with IP restrictions:

### Auth Webhook Endpoint

- **URL**: `GET /auth`
- **Purpose**: Validates requests from Hasura
- **Security**: IP-based restrictions for K8s deployments

### Testing Auth Webhook

```bash
curl -X GET "https://your-worker.workers.dev/auth?authorization=Bearer%20token123"
```

Expected response:
```json
{
  "X-Hasura-Role": "user"
}
```

## Development

### Local Development

```bash
npm run dev
```

### View Logs

```bash
# Production logs
npm run tail:production

# Staging logs  
npm run tail:staging
```

### Deploy to Different Environments

```bash
# Staging
npm run deploy:staging

# Production
npm run deploy:production
```

## Architecture

```
Client Request → Worker → Hasura
                     ↓
                Cache Check
                     ↓
              [Cache Hit/Miss]
                     ↓
              [Fetch from Hasura]
                     ↓
              [Store in Cache]
```

### Cache Key Structure

Cache keys include:
- Request body hash
- User authentication context
- URL path

This ensures:
- Different users get separate caches
- Same query with different auth gets different cache
- Mutations don't interfere with query cache

## Security

### IP Restrictions

For Kubernetes deployments, configure IP restrictions:

```bash
# Set K8s cluster IP range
wrangler secret put HASURA_K8S_CLUSTER_IP
# Value: 10.0.0.0/8

# Or set specific allowed IPs
wrangler secret put ALLOWED_IPS  
# Value: 10.244.1.5,10.244.2.10
```

### Development Mode

If no IP restrictions are configured, all IPs are allowed (development mode).

## Troubleshooting

### Cache Not Working

1. Check if TTL is set correctly
2. Verify cache headers in response
3. Check worker logs: `npm run tail`

### Auth Webhook Issues

1. Verify Hasura webhook URL is correct
2. Check IP restrictions if configured
3. Test webhook directly with curl

### Performance Issues

1. Monitor cache hit rates via headers
2. Adjust TTL values based on data freshness needs
3. Consider using longer TTL for static data

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## License

MIT License - see LICENSE file for details. 