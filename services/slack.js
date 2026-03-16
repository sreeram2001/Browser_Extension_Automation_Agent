const https = require("https");

function postToSlack(message) {
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (!webhookUrl || webhookUrl === "your-slack-webhook-url-here") {
        return Promise.resolve({ success: false, error: "Slack webhook not configured." });
    }

    const url = new URL(webhookUrl);
    const body = JSON.stringify({ text: message });

    return new Promise((resolve) => {
        const req = https.request(
            {
                hostname: url.hostname,
                path: url.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                },
            },
            (res) => {
                let data = "";
                res.on("data", (chunk) => (data += chunk));
                res.on("end", () => {
                    resolve({ success: res.statusCode === 200, response: data });
                });
            }
        );
        req.on("error", (err) => resolve({ success: false, error: err.message }));
        req.write(body);
        req.end();
    });
}

module.exports = { postToSlack };
