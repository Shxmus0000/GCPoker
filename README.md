# GCPoker

A full-stack Texas Hold'em poker platform with real-time gameplay, Discord integration, and Minecraft GC cashier bot.

## Architecture

```
packages/
├── shared/       # Shared types, enums, and interfaces (cards, game state, events)
├── engine/       # Poker game engine (game logic, hand evaluation, tournament management)
├── server/       # Express + Socket.IO backend (auth, cashier, game rooms, Discord bridge)
├── web/          # Next.js frontend (lobby, table UI, cashier, profile)
├── discord/      # Discord bot (embeds, ticket/suggestion systems, role sync, chat bridge)
└── bot/          # Minecraft GC cashier bot (Mineflayer-based, on-demand mode)
```

## Quick Start

### Prerequisites
- Node.js 20+
- npm

### Install & Run

```bash
npm install
npm run dev
```

This starts three processes concurrently:
- **Server** (port 3001) — Express + Socket.IO backend
- **Web** (port 3000) — Next.js frontend
- **Bot** — Minecraft cashier bot (on-demand mode, requires MC credentials)

### Build

```bash
npm run build
```

## Environment Variables

Create a `.env` file in the project root:

| Variable | Description | Default |
|---|---|---|
| `DISCORD_TOKEN` | Discord bot token | (bot disabled) |
| `PORT` | HTTP server port | `3001` |
| `API_KEY` | API key for bot <-> server auth | `dev-key` |
| `MC_HOST` | Minecraft server host | `localhost` |
| `MC_PORT` | Minecraft server port | `25565` |
| `MC_USERNAME` | Minecraft account email | `CashierBot` |
| `MC_PASSWORD` | Minecraft account password | (empty) |
| `MC_AUTH` | Auth method | `offline` |
| `MC_VERSION` | Minecraft version | (auto-detect) |
| `MC_SERVER` | Server to auto-join (`/factions`) | (empty) |
| `MC_SERVER_COMMANDS` | Post-login commands (comma-separated) | (empty) |
| `BACKEND_URL` | Backend URL for bot API calls | `http://localhost:3001` |
| `BOT_POLL_INTERVAL` | Bot job poll interval (ms) | `3000` |
| `DISCORD_CONFIG_PATH` | Discord config file path | `server/data/discord-config.json` |
| `TICKETS_DATA_PATH` | Tickets data file path | `server/data/tickets.json` |
| `TICKET_LOG_MSG_PATH` | Ticket log message ID file | `server/data/ticket-log-msg.json` |
| `SUGGESTIONS_DATA_PATH` | Suggestions data file path | `server/data/suggestions.json` |

## Packages

### `@gcpoker/shared`
Core types shared across all packages: card enums, game state interfaces, event constants, player/tournament/cashier types, and socket event definitions.

### `@gcpoker/engine`
Pure poker game engine with no I/O dependencies:
- Texas Hold'em game loop (pre-flop through showdown)
- Hand evaluation with kicker comparison
- Side pot calculation
- Tournament management (blind levels, prize distribution, table balancing)
- Player-created game rooms
- Provably fair deck shuffling
- Hand history recording

### `@gcpoker/server`
Express + Socket.IO backend:
- **Auth** — Username/password signup/signin with session tokens, Discord linking
- **Games** — Player-created game rooms with WebSocket state sync
- **Tables** — Table lifecycle management (create, join, leave, sit, stand)
- **Tournaments** — Tournament lifecycle (register, start, balance tables, payouts)
- **Cashier** — Deposit/withdrawal queue, GC code management
- **Discord Bridge** — Relays in-game chat to Discord channels and vice versa
- **Events** — Typed EventEmitter for server <-> Discord communication

### `@gcpoker/web`
Next.js 14 frontend:
- Lobby with game and tournament listings
- Real-time poker table UI with WebSocket
- Cashier page for deposits/withdrawals
- User profile with Discord linking
- Hand history viewer with replay
- Player stats tracking

### `@gcpoker/discord`
Full-featured Discord bot:
- **Game/Tournament Embeds** — Real-time updates for lobby, game lifecycles, tournament progress, high-stakes alerts, and bad beat posts
- **Config Panel** — Interactive admin panel for managing channel/role assignments
- **Ticket System** — Create/manage/close support tickets with PDF transcripts
- **Suggestion System** — Community suggestions with upvote/downvote voting
- **Reaction Roles** — Opt-in ping roles (tournament alerts, high stakes, etc.)
- **Role Sync** — Auto-assigns Verified role on Discord link, removes Guest
- **Chat Bridge** — Bidirectional relay between in-game and Discord channels
- **Permission Setup** — `/setup-permissions` command to configure channel and role permissions
- **Command Logging** — Logs all slash command usage to a staff channel

#### Discord Slash Commands
| Command | Description | Permission |
|---|---|---|
| `/link` | Get a one-time code to link your Discord account | Everyone |
| `/confirmdeletion` | Get a code to confirm account deletion | Everyone |
| `/config` | Post the interactive configuration panel | Everyone (posts to channel) |
| `/setup-reaction-roles` | Post the reaction role message | Administrator |
| `/setup-permissions` | Scan and configure channel/role permissions | Administrator |
| `/ticket adduser` | Add a user to a support ticket | Ticket member |
| `/ticket removeuser` | Remove a user from a support ticket | Ticket member |
| `/ticket close` | Close the current support ticket | Ticket member |

### `@gcpoker/bot`
Minecraft GC cashier bot using Mineflayer:
- Connects to a Minecraft server (Complex MC)
- Polls a job queue from the backend
- Processes deposit/withdrawal requests in-game
- Responds with transaction confirmations

## Discord Permission Zones

The `/setup-permissions` command configures these permission zones:

| Category | Guest | @everyone | Verified | Staff |
|---|---|---|---|---|
| INFORMATION | View only | View only | View only | Full |
| POKER | Hidden | View only | View only | Full |
| BANKING | Hidden | Hidden | View only | Full |
| SUPPORT | Hidden | View only | View only | Full |
| COMMUNITY | Hidden | Full | Full | Full |
| VOICE | Hidden | Full | Full | Full |
| STAFF | Hidden | Hidden | Hidden | Full |
| Bot Control | Hidden | Hidden | Hidden | Full |

## Data Storage

Runtime data is stored in `packages/server/data/` as JSON files:
- `users.json` — User accounts (passwords hashed with scrypt)
- `sessions.json` — Active session tokens
- `transactions.json` — Deposit/withdrawal transaction records
- `games.json` — Player-created game records
- `tournaments.json` — Tournament records
- `discord-config.json` — Discord bot channel/role configuration
- `tickets.json` — Support ticket records
- `ticket-log-msg.json` — Cached ticket log message ID
- `suggestions.json` — Community suggestion records
- `chat-bridges.json` — Room-to-channel bridge mappings
