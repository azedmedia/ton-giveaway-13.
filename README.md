# TON Drop — 13-slot giveaway

A mobile-friendly TON giveaway page with:
- 13 total accepted wallet addresses
- 0.052 TON stated reward per accepted address
- TON address parsing/validation with `@ton/core`
- one claim per wallet address
- SQLite storage and a transaction to protect the final slot from simultaneous submissions
- private Telegram message for each accepted claim
- no user account, name, email, password, seed phrase, or private key collection
- manual payouts only; the app never sends TON

## Important before launch

This project stores submitted TON addresses on the server and sends them to the Telegram chat configured by the organizer. Add a short privacy notice or terms if you want to explain how addresses are used. Do not promise payouts you cannot fund. Do not ask participants for seed phrases/private keys.

## Run locally

Requires Node.js 20 or newer.

1. Extract the ZIP.
2. In this folder, run `npm install`.
3. Copy `.env.example` to `.env`.
4. Fill in `BOT_TOKEN` and `ADMIN_CHAT_ID`.
5. Run `npm start`.
6. Open `http://localhost:3000`.

## Set up Telegram notifications

1. In Telegram, open the official `@BotFather` account and create a bot with `/newbot`.
2. Copy the bot token into `BOT_TOKEN`. Keep it secret.
3. Open your new bot and press Start.
4. Obtain your numeric Telegram chat ID using a trusted method or a bot you trust. Put it in `ADMIN_CHAT_ID`.
5. Test locally with a wallet address you control before publishing.

Do not put the bot token in frontend files, screenshots, public chats, GitHub, or the deployed site's public environment. If it leaks, revoke it with BotFather and create a new one.

## Deploy

Use a Node.js host that supports persistent disk storage. The SQLite database lives at `data/giveaway.sqlite`; ephemeral filesystems can erase entries after restarts or redeploys. Configure a persistent volume mounted at this project's `data/` directory if the host supports it.

Set these environment variables in the hosting dashboard:
- `BOT_TOKEN`
- `ADMIN_CHAT_ID`
- `NODE_ENV=production` (if supported)

Build/install command: `npm install`
Start command: `npm start`

After deployment, test:
- site loads over HTTPS
- a valid address can claim once
- same address is rejected the second time
- Telegram receives the address privately
- after 13 unique addresses, the page says “Reward Fully Claimed”
- restart/redeploy does not wipe the database

## Hosting note

Do not use a static-only host for this project: the claim limit, database, and Telegram notifications need a server. Choose a Node.js host with persistent storage or migrate SQLite to a managed database before using a host with ephemeral disks.
