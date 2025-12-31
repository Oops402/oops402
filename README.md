# Oops!402 MCP Server

Oops!402 is an MCP (Model Context Protocol) server that unlocks commerce for AI agents. It provides tools for AI agents to discover services, make payments, and interact with the x402 payment protocol ecosystem.

## What is Oops!402?

Oops!402 gives AI agents the ability to:
- **Manage wallets**: Create and manage self-custodial x402-compatible wallets for AI agents using [Lit Protocol](https://litprotocol.com) Programmable Key Pairs (PKPs)
- **Discover services**: Find x402-protected resources from the Facilitator's Bazaar
- **Discover agents**: Search for other AI agents that support x402 payments
- **Make payments**: Execute x402 payments to protected resources and services
- **Transfer tokens**: Send ERC20 tokens (like USDC) on EVM chains

### Architecture Highlights

- **OAuth Authentication**: Uses [Auth0](https://auth0.com) as the OAuth 2.0 provider for secure authentication
- **Self-Custodial Wallets**: Leverages [Lit Protocol](https://litprotocol.com) Lit Actions to create and manage Programmable Key Pairs (PKPs) that are bound to OAuth identities. Lit Actions verify Auth0 JWT tokens to ensure only authenticated users can access their wallets.
- **Agent Discovery**: Uses [ERC8004 (Agent0)](https://github.com/agent0-protocol/agent0) for discovering AI agents on-chain. Agents register their capabilities, MCP tools, A2A skills, and x402 payment support on Agent0 smart contracts.
- **Resource Discovery**: Automatically crawls and caches x402-protected resources from the [Coinbase x402 Facilitator Bazaar](https://api.cdp.coinbase.com/platform/v2/x402) discovery API, enabling agents to discover paid services and capabilities without hardcoded endpoints.
- **MCP Protocol**: Implements the [Model Context Protocol](https://modelcontextprotocol.io) for seamless integration with AI applications like ChatGPT and Claude

The [Model Context Protocol](https://modelcontextprotocol.io) enables seamless integration between AI applications and external data sources, tools, and services.

## Table of Contents

- [Quick Start](#quick-start)
- [Connecting to ChatGPT and Claude](#connecting-to-chatgpt-and-claude)
- [MCP Features](#mcp-features)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Connecting to ChatGPT and Claude

### Connecting to ChatGPT

1. **Enable Developer Mode in ChatGPT**
   - Open your ChatGPT interface and navigate to **Settings**
   - Select the **Connectors** tab
   - Click on **Advanced settings**
   - Toggle on **Developer Mode**. This unlocks the options for creating custom connectors.

2. **Create a Custom Connector**
   - In the Connectors settings, click on **Create**
   - Provide the information for your MCP server:
     - **Name**: Oops!402 (or any descriptive name)
     - **Description** (Optional): Unlock commerce for AI agents with x402 wallet, discovery, and payment tools
     - **Icon** (Optional): Provide an icon for easy identification
     - **MCP server URL**: `https://oops402.com/mcp`
   - Make sure **Authentication** is set to **"OAuth"**
   - Confirm that you trust this application by clicking the checkbox
   - Click **Create**

3. **Connect and Use**
   - After creating the connector, click **Connect** to go through the OAuth authentication flow
   - Once connected, you can enable specific tools from the "Search and tools" menu
   - Start using Oops!402 tools in your conversations!

### Connecting to Claude

1. **Navigate to Connectors Settings**
   - Go to **Settings > Connectors** (for Pro and Max plans)
   - Or **Admin settings > Connectors** (for Team and Enterprise plans)

2. **Add Custom Connector**
   - Locate the **"Connectors"** section
   - Click **"Add custom connector"** at the bottom of the section
   - Add your connector's remote MCP server URL: `https://oops402.com/mcp`
   - Optionally, click **"Advanced settings"** to specify an OAuth Client ID and OAuth Client Secret for your server
   - Finish configuring your connector by clicking **"Add"**

3. **Enable and Use**
   - Enable connectors via the **"Search and tools"** button on the lower left of your chat interface
   - For connectors that require authentication, click **"Connect"** to go through the authentication flow
   - After connecting, use the same menu to enable or disable specific tools made available by the server
   - Start using Oops!402 tools in your conversations!

## Quick Start

### Using with ChatGPT or Claude

The easiest way to use Oops!402 is to connect it as a custom connector in ChatGPT or Claude:

**MCP Server URL:** `https://oops402.com/mcp`

See the [Connecting to ChatGPT and Claude](#connecting-to-chatgpt-and-claude) section below for detailed instructions.

### Local Development

To run the server locally:

```bash
# Clone and install
git clone <repository-url>
cd oops402
npm install

# Start the server with in-process demo auth and in-memory session management
npm run dev:internal

# In another terminal, run MCP Inspector
npx -y @modelcontextprotocol/inspector

# Inspector will open a browser window.
# Connect to http://localhost:3232/mcp to authenticate and explore server features
```

The server is now running a lightweight config with everything bundled in a single process:
- authentication is handled by an in-process demo OAuth server (for development only)
- sessions are stored in memory, rather than in Redis

**Note:** 
- In production, Oops!402 uses **Auth0** for OAuth authentication and **Lit Protocol** for self-custodial wallet creation
- The internal auth mode is only for local development and testing
- For production-like testing, configure `AUTH_MODE=external` and `AUTH_PROVIDER=auth0` with your Auth0 credentials

Other configurations are available: see [Development Setup](#development-setup), below.

## MCP Features

This server provides the following MCP tools for AI agents:

### Wallet Tools
- **`get_x402_wallet`**: Get or create a self-custodial x402 wallet for the authenticated agent/user. Wallets are created using Lit Protocol Programmable Key Pairs (PKPs), which are cryptographically bound to the user's Auth0 OAuth identity via Lit Actions. Returns wallet address, ETH and USDC balances, budget preferences (per-request max, session budget, session spending, remaining budget), and discovery preferences (only promoted resources, minimum agent score).
- **`get_x402_wallet_balance`**: Get ETH and token balances for an x402 wallet
- **`transfer_x402_token`**: Transfer ERC20 tokens (defaults to USDC on Base network)

### Discovery Tools
- **`discover_x402_agents`**: Discover agents and services that support x402 payments using [ERC8004 (Agent0)](https://github.com/agent0-protocol/agent0). Supports both regular search (by name, MCP/A2A endpoints, tools, skills) and reputation-based search (by tags, ratings). Agents are discovered from on-chain Agent0 registries.
- **`list_x402_agent_tools`**: List capabilities/tools available from a specific agent registered on Agent0
- **`search_x402_bazaar_resources`**: Discover x402-protected resources from the [Coinbase x402 Facilitator Bazaar](https://api.cdp.coinbase.com/platform/v2/x402). Resources are automatically crawled and cached from the Coinbase discovery API, enabling agents to find paid services and capabilities.

### Payment Tools
- **`make_x402_payment`**: Make x402 payment to a protected resource/service
- **`get_x402_payment_history`**: Get recent payment history for an x402 wallet address using x402scan. Returns a list of payments made by the wallet, including transaction hashes, amounts, recipients, timestamps, and other payment details.

### Preferences & Budget Tools
- **`set_x402_preferences`**: Set user preferences for budget limits and discovery filters. Budget amounts are in human-readable USDC format (e.g., '0.05' for 0.05 USDC). All parameters are optional for partial updates. Supports:
  - **Budget Limits**: Set per-request maximum and session budget limits
  - **Discovery Filters**: Configure to show only promoted resources/agents and set minimum agent score threshold

### Additional MCP Features
- **[Resources](https://modelcontextprotocol.io/docs/concepts/resources)**: Example resources with pagination and subscription support
- **[Prompts](https://modelcontextprotocol.io/docs/concepts/prompts)**: Simple and complex prompts with argument support
- **Transports**: Streamable HTTP (recommended) and SSE (legacy)

## Budget & Preferences System

Oops!402 includes a comprehensive budget and preferences system that allows users to control spending limits and filter discovery results based on trust and quality metrics.

### Budget Limits

Users can set two types of budget limits that persist across sessions:

- **Per-Request Maximum**: Maximum amount allowed per individual payment request (e.g., 0.05 USDC)
- **Session Budget**: Total amount available for the current session (e.g., 5.00 USDC)

Budget limits are enforced before payments are processed:
- Payments exceeding the per-request maximum are blocked
- Payments that would exceed the remaining session budget are blocked
- Session spending is tracked in Redis and automatically resets when the session expires

### Discovery Preferences

Users can configure discovery filters to control which services and agents are shown:

- **Only Promoted Resources/Agents**: When enabled, only resources and agents with active promotions are shown in discovery results. This helps users discover validated, high-quality services.
- **Minimum Agent Score**: Set a minimum average score threshold (0-100) for agents. Only agents with scores at or above this threshold will be shown in discovery results.

### Storage Architecture

- **Supabase**: Persistent user preferences (budget limits, discovery filters) - survives sessions and server restarts
- **Redis**: Session-scoped spending tracking (temporary, tied to OAuth token/session lifecycle, typically 7 days)

Preferences are automatically applied to:
- Discovery endpoints (`/api/discover/agents`, `/api/discover/bazaar`)
- MCP tools (`discover_x402_agents`, `search_x402_bazaar_resources`)
- Payment validation (budget limits are checked before processing payments)

### Web Dashboard

The wallet dashboard (`/wallet`) provides a user-friendly interface for managing budget and trust settings:
- View current budget limits and remaining session budget
- Configure per-request maximum and session budget
- Set discovery preferences (only promoted, minimum agent score)
- Monitor session spending in real-time

## Development Setup

### Prerequisites
- Node.js >= 16
- npm or yarn
- TypeScript (installed automatically via npm install, required for building)
- Docker (optional, for Redis)

### Running The Server

The codebase supports a number of configurations ranging from simple/exploratory to something closer to how a production deployment would look. 

#### Configuration Options Overview

| | Development/Exploration | Production |
|--------|----------------------|------------|
| **Auto-restart** | `npm run dev:*` <br> • Auto-restarts on file changes <br> • Verbose logging <br> • Source maps enabled | `npm run start:*` <br> • Requires build step first <br> • Optimized performance <br> • No auto-restart |
| **Auth Mode** | `internal` <br> • Demo OAuth in same process <br> • Single port (3232) <br> • Easier to debug <br> • **Not for production** | `external` with `AUTH_PROVIDER=auth0` <br> • Uses Auth0 as OAuth provider <br> • Production-ready authentication <br> • JWT token validation <br> • Lit Actions verify Auth0 tokens |
| **Session Storage** | In-memory <br> • No dependencies <br> • Sessions lost on restart <br> • Single instance only | Redis <br> • Requires Docker/Redis <br> • Sessions persist <br> • Multi-instance ready |

Server configuration is determined by environment variables. To set up a non-default configuration, copy [`.env.example`](.env.example) to `.env` and edit as desired, or pass non-defaults on the command line.

Some example commands for different configurations are listed below. See the [Authentication Config](#authentication-config) and [Session Management Config](#session-management-config) sections below for detailed instructions on changing those configurations.

```bash
# Development mode - watches for file changes and auto-restarts
npm run dev:internal    # Internal auth
# or
npm run dev:external    # External auth

# Production mode - optimized build, no auto-restart
npm run build          # Build TypeScript to JavaScript first
# then
npm run start:internal    # Internal auth
# or
npm run start:external    # External auth

# Redis-backed sessions
docker compose up -d   # Start Redis first
# configure REDIS_URL or pass on command line - see Session Management Config below - e.g.
REDIS_URL=redis://localhost:6379 npm run dev:internal
# Sessions will now persist across restarts

# Verify Redis is being used
npm run dev:internal 2>&1 | grep -i redis
# Should show: "Redis client connected successfully" or similar
```

## Authentication Config

This repo implements the [separate auth server](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization#roles) architecture pattern described in the MCP specification, in which the MCP server is the "resource server", and authorization functionality is hosted separately.

### Production Configuration (Auth0)

In production, Oops!402 uses [Auth0](https://auth0.com) as the OAuth 2.0 provider. Auth0 handles:
- User authentication via OAuth 2.0 with PKCE
- JWT token issuance and validation
- User identity management

The MCP server validates Auth0 JWT tokens and uses them to:
- Authenticate MCP client requests
- Create and manage Lit Protocol PKP wallets bound to Auth0 user identities
- Verify wallet ownership via Lit Actions that validate Auth0 tokens

### Wallet Creation with Lit Protocol

Oops!402 uses [Lit Protocol](https://litprotocol.com) to create self-custodial wallets:

1. **Programmable Key Pairs (PKPs)**: Each user gets a unique PKP that serves as their wallet address
2. **Lit Actions**: Custom Lit Actions verify Auth0 JWT tokens to ensure only authenticated users can access their PKPs
3. **OAuth Binding**: PKPs are cryptographically bound to Auth0 user identities (`oauth:${auth0_user_id}`)
4. **Session Signatures**: Lit Actions generate session signatures that allow the PKP to sign transactions without exposing private keys

This architecture ensures that:
- Users maintain full custody of their wallets (keys are managed by Lit Protocol)
- Wallet access is tied to Auth0 authentication
- No private keys are ever exposed to the application server

### Development Configuration

For local development, the server supports an **internal auth mode** where a demo OAuth server runs in-process. This is useful for testing but should not be used in production.

**Authentication Environment Variables:**

- `AUTH_MODE` - Sets the authentication mode:
  - `internal` (default for local dev) - Demo OAuth endpoints run in-process with the MCP server
  - `external` - Use external OAuth provider (Auth0 in production)
  - `auth_server` - Run only the OAuth server (for testing)

- `AUTH_PROVIDER` - OAuth provider type (when `AUTH_MODE=external`):
  - `auth0` - Use Auth0 as OAuth provider (production)
  - `okta` - Use Okta as OAuth provider
  - `generic` - Use generic OAuth provider

- `AUTH0_DOMAIN` - Auth0 domain (required when `AUTH_PROVIDER=auth0`):
  - Example: `oops402pay.us.auth0.com`

- `AUTH0_AUDIENCE` - Auth0 API audience/identifier (optional):
  - Example: `urn:oops402`

- `AUTH_SERVER_URL` - URL of the external auth server (required when `AUTH_MODE=external` and `AUTH_PROVIDER=generic`)
  - Example for local demo: `http://localhost:3001`
  - Example for Okta: `https://your-domain.okta.com`

**Security Configuration:**

- `LIT_SESSION_SIG_DURATION_MINUTES` - Session signature duration in minutes (default: 10)
  - Controls how long PKP session signatures remain valid
  - Should match or be shorter than the token max age enforced by Lit Actions (1 hour)
  - Example: `60` (1 hour)

**Token Expiration and Security:**

Oops!402 implements multiple layers of token expiration for enhanced security:

1. **Auth0 Token Expiration**: Configured in the Auth0 dashboard (recommended: 1 hour or less)
   - This is the primary expiration time for OAuth tokens issued by Auth0
   - Configure in Auth0 Dashboard → APIs → Your API → Settings → Token Expiration

2. **Lit Action Token Max Age**: Hardcoded constant in the Lit Action (`MAX_TOKEN_AGE_SECONDS = 3600` = 1 hour)
   - The Lit Action enforces a maximum token age of 1 hour, regardless of Auth0's expiration setting
   - Even if Auth0 allows longer token expiration, tokens older than 1 hour will be rejected
   - This provides defense in depth against token theft attacks

3. **Session Signature Duration**: Configurable via `LIT_SESSION_SIG_DURATION_MINUTES` (default: 1 hour)
   - Session signatures automatically expire when tokens would be considered too old
   - Ensures no session signatures exist for tokens that would be rejected by the Lit Action
   - Users must re-authenticate when tokens age out

**Security Relationship:**
- Session signature duration should match or be shorter than the Lit Action's token max age (1 hour)
- If a token is stolen, the maximum window of vulnerability is limited to the token max age (1 hour)
- All three layers work together to minimize the attack surface

## Session Management Config

By default, the server uses in-memory session storage for development and local single-session testing. This simplifies getting the server up and running for exploration, but confines sessions to a single server instance and destroys them on server restarts. 

For multi-instance testing and persistent sessions, the server also supports Redis-managed session storage.

**Setting up Redis:**

1. **Install Docker** (if not already installed):
   - macOS: [Docker Desktop for Mac](https://docs.docker.com/desktop/install/mac-install/)
   - Windows: [Docker Desktop for Windows](https://docs.docker.com/desktop/install/windows-install/)
   - Linux: [Docker Engine](https://docs.docker.com/engine/install/)

2. **Start Redis** using Docker Compose:
   ```bash
   docker compose up -d  # Starts Redis in the background
   ```

   To stop Redis later:
   ```bash
   docker compose down
   ```

3. **Configure the server** to use Redis by setting environment variables:

    **Session Storage Environment Variables:**

    - `REDIS_URL` - Redis connection URL (optional)
      - When set: Sessions are stored in Redis (persistent across restarts)
      - When not set: Sessions use in-memory storage (lost on restart)
      - Default: Not set (in-memory storage)
      - Example: `redis://localhost:6379` (Redis default port)

    - `REDIS_TLS` - Enable TLS for Redis connection
      - Set to `1` or `true` to enable TLS
      - Default: `0` (disabled)

    - `REDIS_PASSWORD` - Redis password for authentication (if required)

    - `NODE_ENV` - Controls Redis connection failure behavior:
      - `development` (default) - Server continues with warning if Redis fails
      - `production` - Server exits if Redis connection fails

    Note: Docker container config can be found in `.devcontainer/docker-compose.yml`.

## Bazaar Crawl Configuration

Oops!402 automatically crawls and caches x402-protected resources from the [Coinbase x402 Facilitator Bazaar](https://api.cdp.coinbase.com/platform/v2/x402) discovery API. This enables agents to discover paid services and capabilities without hardcoded endpoints.

**Bazaar Configuration Environment Variables:**

- `X402_FACILITATOR_URL` - URL of the Coinbase x402 Facilitator API (optional)
  - Default: `https://api.cdp.coinbase.com/platform/v2/x402`
  - Example: `https://api.cdp.coinbase.com/platform/v2/x402`

- `X402_BAZAAR_CACHE_FILE` - Path to the cache file for crawled resources (optional)
  - Default: `bazaar-resources.json`
  - Example: `./data/bazaar-resources.json`

- `X402_BAZAAR_CRAWL_INTERVAL_MS` - Interval between bazaar crawls in milliseconds (optional)
  - Default: `3600000` (1 hour)
  - Example: `1800000` (30 minutes)

The bazaar crawl runs automatically as a background cron job, fetching all available x402-protected resources and caching them locally for fast discovery queries. Resources are paginated and fetched with rate limiting and retry logic to handle API constraints gracefully.

## Agent0 (ERC8004) Configuration

Agent discovery uses [ERC8004 (Agent0)](https://github.com/agent0-protocol/agent0) to query on-chain agent registries. Agents register their capabilities, MCP tools, A2A skills, and x402 payment support on Agent0 smart contracts.

**Agent0 Configuration Environment Variables:**

- `AGENT0_CHAIN_ID` - Chain ID where Agent0 contracts are deployed (optional)
  - Default: `84532` (Base Sepolia testnet)
  - Example: `8453` (Base mainnet)

- `AGENT0_RPC_URL` - RPC URL for the blockchain network (optional)
  - Default: `https://sepolia.infura.io/v3/YOUR_PROJECT_ID`
  - Example: `https://mainnet.base.org` (Base mainnet public RPC)

The Agent0 SDK queries on-chain registries to discover agents that support x402 payments, MCP endpoints, A2A skills, and other capabilities. Both regular search and reputation-based search are supported.

## Promotion & Analytics System

Oops!402 includes a monetization platform that allows anyone to promote their x402 resources or ERC8004 agents in search results, similar to Google Ads for AI agents. The system tracks all payments and provides analytics on search behavior and resource usage.

### Promotion Features

- **Self-Service Promotions**: Anyone can promote their x402 resources or agents by paying a flat fee
- **Promoted Results**: Promoted resources appear first in search results with a "Promoted" badge
- **Schema Validation**: Resources are validated to ensure they have valid x402 schemas before promotion
- **Performance Tracking**: Track clicks, impressions, CTR, payments received, and revenue for each promotion

### Analytics Features

- **My Promotions Dashboard**: View performance metrics for all your promotions
  - Total clicks, impressions, and CTR
  - Payments received and revenue
  - Conversion rates
  - Top performing promotions
- **Global Trends Dashboard**: View aggregated analytics across the platform
  - Top searched keywords
  - Most popular tools (by payment volume)
  - Overall payment statistics

### Promotion Configuration

**Supabase Configuration (Required for promotions):**

- `SUPABASE_URL` - Supabase project URL (required)
- `SUPABASE_ANON_KEY` - Supabase anonymous key (required)
- `SUPABASE_KEY` - Supabase service role key (required)

**Promotion Configuration:**

- `PROMOTION_FEE_PER_DAY` - Fee per day for promotions in USDC (optional)
  - Default: `0.01` (0.01 USDC per day)
  - Example: `0.05` (0.05 USDC per day)
  - Users specify the number of days, total fee is calculated as `days × fee_per_day`

- `PROMOTION_PAYMENT_RECIPIENT` - Wallet address that receives promotion payments (optional)
  - If not set, only transaction amount and sender are validated
  - If set, transactions must be sent to this address
  - Example: `0x1234...5678`

- `PROMOTION_CHAIN_ID` - Chain ID for promotion payments (optional)
  - Default: `8453` (Base mainnet)
  - Example: `84532` (Base Sepolia testnet)

**Payment Verification:**

Before a promotion is created, the system verifies:
- The transaction exists and is confirmed on-chain
- The transaction amount matches the calculated fee (`days × fee_per_day`)
- The transaction is sent from the expected wallet address
- The transaction is sent to the configured recipient (if `PROMOTION_PAYMENT_RECIPIENT` is set)

**Database Setup:**

Run the SQL schema in `docs/supabase-schema.sql` on your Supabase database to create the required tables:
- `oops402_promotions` - Active promotions
- `oops402_payments` - All payments tracked
- `oops402_promotion_payments` - Links payments to promotions
- `oops402_search_analytics` - Search query tracking
- `oops402_click_analytics` - Click tracking for promoted results
- `oops402_promotion_impressions` - Impression tracking for CTR calculation
- `oops402_user_preferences` - User preferences for budget limits and discovery filters

### Privacy & Legal Considerations

**Privacy Compliance:**

- Only wallet addresses are stored (pseudonymous, not personal data)
- Session IDs are hashed before storage
- No IP addresses or personal identification data is stored
- Analytics are aggregated, not per-user
- Users pay directly to resource owners via x402
- Payment tracking is passive observation, not payment processing

### Testing Features With MCP Inspector

As noted above, MCP Inspector is the recommended way to explore the server's capabilities:

```bash
# With server running
npx -y @modelcontextprotocol/inspector

# 1. Connect to http://localhost:3232/mcp (adjust port to match current config is needed)
# 2. Go through authorization steps
# 3. Explore OAuth authentication in the Auth tab
# 4. Test tools, resources, and prompts interactively
```

### Example Scripts

The `examples/` directory contains scripts that interact with MCP endpoints directly, without use of SDK functionality. These can help build intuition for how the protocol works under the hood:
- `client.js` - Node.js client demonstrating OAuth and MCP operations
- `curl-examples.sh` - Shell script showing raw HTTP usage

### Running Tests

```bash
npm run lint      # Code linting
npm run typecheck # Type checking
npm test          # Unit tests
npm run test:e2e  # End-to-end tests
```

## Project Structure

```
.
├── src/                      # Source code
│   ├── index.ts              # Server entry point
│   ├── config.ts             # Configuration management
│   ├── interfaces/
│   │   └── auth-validator.ts # Clean auth/MCP boundary
│   ├── modules/
│   │   ├── auth/             # OAuth 2.0 implementation (demo for dev, Auth0 for prod)
│   │   │   ├── auth/         # Core auth logic and providers
│   │   │   ├── handlers/     # Mock upstream IdP handler (dev only)
│   │   │   ├── services/     # Auth and Redis-backed session services
│   │   │   ├── static/       # OAuth frontend assets
│   │   │   ├── webAuth.ts    # Auth0 web authentication middleware
│   │   │   ├── index.ts      # Auth module router
│   │   │   └── types.ts      # Auth type definitions
│   │   ├── wallet/           # Wallet management with Lit Protocol
│   │   │   ├── litAction.ts  # Lit Action code for Auth0 JWT verification
│   │   │   ├── litService.ts # Lit Protocol service integration
│   │   │   └── ...           # Wallet creation and management
│   │   ├── agents/           # Agent discovery using ERC8004 (Agent0)
│   │   │   └── service.ts    # Agent0 SDK integration for on-chain agent discovery
│   │   ├── x402/             # x402 payment protocol integration
│   │   │   ├── bazaarService.ts # Coinbase x402 Bazaar crawling and caching
│   │   │   ├── schemaValidation.ts # Shared x402 schema validation logic
│   │   │   └── service.ts    # x402 payment execution
│   │   ├── promotions/       # Promotion system
│   │   │   ├── service.ts    # Promotion CRUD and validation
│   │   │   └── types.ts      # Promotion type definitions
│   │   ├── preferences/      # Budget and preferences system
│   │   │   ├── service.ts    # Preferences CRUD (Supabase) and session spending (Redis)
│   │   │   └── types.ts      # Preferences type definitions
│   │   ├── analytics/        # Analytics and tracking
│   │   │   ├── service.ts    # Payment, search, click, and impression tracking
│   │   │   └── types.ts      # Analytics type definitions
│   │   ├── mcp/              # MCP protocol implementation
│   │   │   ├── handlers/     # Streamable HTTP and SSE handlers
│   │   │   ├── services/     # MCP core and Redis transport
│   │   │   ├── index.ts      # MCP module router
│   │   │   └── types.ts      # MCP type definitions
│   │   └── shared/           # Shared utilities
│   │       ├── logger.ts     # Logging configuration
│   │       ├── redis.ts      # Redis client with mock fallback
│   │       └── supabase.ts   # Supabase client initialization
│   └── static/               # Static web assets
├── examples/                 # Example client implementations
│   ├── client.js             # Node.js client with OAuth flow
│   └── curl-examples.sh      # Shell script with curl examples
├── docs/                     # Additional Documentation
│   └── supabase-schema.sql  # Supabase database schema for promotions/analytics
├── tests/                    # Test files
├── .env.example              # Environment variable template
├── docker-compose.yml        # Docker setup for Redis
├── package.json              # Node.js dependencies
└── tsconfig.json             # TypeScript configuration
```

## Documentation

Additional documentation can be found in the `docs/` directory:

- [OAuth Implementation](docs/oauth-implementation.md) - Complete OAuth 2.0 + PKCE guide with architecture, flows, and commercial provider integration
- [Session Ownership](docs/session-ownership.md) - Multi-user session isolation and Redis-backed ownership tracking

### Other Resources

- [Model Context Protocol Documentation](https://modelcontextprotocol.io)
- [MCP Specification](https://modelcontextprotocol.io/specification)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [Lit Protocol Documentation](https://developer.litprotocol.com) - Programmable Key Pairs and Lit Actions
- [Auth0 Documentation](https://auth0.com/docs) - OAuth 2.0 authentication
- [ERC8004 (Agent0) Protocol](https://github.com/agent0-protocol/agent0) - On-chain agent registry and discovery
- [Coinbase x402 Facilitator](https://api.cdp.coinbase.com/platform/v2/x402) - x402 payment protocol and resource discovery

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License - see [LICENSE](LICENSE) file for details.
