# Hasura Cache Worker

A Cloudflare Worker that acts as a caching proxy for Hasura GraphQL API with webhook authentication support.

## Features

- ✅ **GraphQL Caching**: Intelligent caching of GraphQL queries with configurable TTL
- ✅ **Webhook Authentication**: IP-restricted auth webhook for Hasura
- ✅ **User-Specific Cache**: Separate cache keys for different users/authentication contexts
- ✅ **Flexible TTL**: Minimum 8-second cache with client-configurable TTL via headers
- ✅ **Mutation Support**: Mutations bypass cache but are still processed
- ✅ **Kubernetes Ready**: IP-based security for K8s deployments

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