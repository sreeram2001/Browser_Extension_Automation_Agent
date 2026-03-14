/**
 * One-time Google OAuth2 setup script.
 * 
 * Prerequisites:
 *   1. Place your OAuth credentials.json in the project root
 *   2. Run: node google-auth.js
 *   3. Follow the browser prompt to authorize
 *   4. Token is saved to google-token.json for the server to use
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { google } = require("googleapis");
const open = require("child_process").exec;

const CREDENTIALS_PATH = path.join(__dirname, "credentials.json");
const TOKEN_PATH = path.join(__dirname, "google-token.json");
const SCOPES = [
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/calendar",
];
const REDIRECT_PORT = 3001;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;

async function main() {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        console.error("Missing credentials.json — download it from Google Cloud Console.");
        process.exit(1);
    }

    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
    const { client_id, client_secret } = creds.installed || creds.web;

    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        scope: SCOPES,
        prompt: "consent",
    });

    console.log("Opening browser for authorization...\n");

    // Open browser (macOS)
    require("child_process").exec(`open "${authUrl}"`);

    // Start local server to catch the callback
    const server = http.createServer(async (req, res) => {
        if (!req.url.startsWith("/oauth2callback")) return;

        const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
        const code = url.searchParams.get("code");

        if (!code) {
            res.end("No authorization code received.");
            server.close();
            return;
        }

        try {
            const { tokens } = await oauth2Client.getToken(code);
            fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
            console.log(`Token saved to ${TOKEN_PATH}`);
            res.end("Authorization successful! You can close this tab.");
        } catch (err) {
            console.error("Error getting token:", err.message);
            res.end("Authorization failed.");
        }

        server.close();
    });

    server.listen(REDIRECT_PORT, () => {
        console.log(`Waiting for OAuth callback on port ${REDIRECT_PORT}...`);
    });
}

main();
