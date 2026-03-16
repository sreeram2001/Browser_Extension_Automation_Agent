const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const CREDENTIALS_PATH = path.join(__dirname, "..", "credentials.json");
const TOKEN_PATH = path.join(__dirname, "..", "google-token.json");

function getGoogleAuth() {
    if (!fs.existsSync(CREDENTIALS_PATH) || !fs.existsSync(TOKEN_PATH)) {
        throw new Error("Google credentials not configured. Run: node google-auth.js");
    }

    const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
    const { client_id, client_secret } = creds.installed || creds.web;
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret);
    const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    oauth2Client.setCredentials(tokens);

    // Auto-refresh token
    oauth2Client.on("tokens", (newTokens) => {
        const merged = { ...tokens, ...newTokens };
        fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
    });

    return oauth2Client;
}

module.exports = { getGoogleAuth };
