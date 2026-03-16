const { ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");

const groundingCache = new Map();
const CACHE_MAX = 50;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getCachedGrounding(query) {
    const key = query.toLowerCase().trim();
    const entry = groundingCache.get(key);
    if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
        return entry.data;
    }
    if (entry) groundingCache.delete(key);
    return null;
}

function setCachedGrounding(query, data) {
    const key = query.toLowerCase().trim();
    if (groundingCache.size >= CACHE_MAX) {
        const oldest = groundingCache.keys().next().value;
        groundingCache.delete(oldest);
    }
    groundingCache.set(key, { data, ts: Date.now() });
}

async function performWebGrounding(query, bedrockClient, groundingModelId) {
    const cached = getCachedGrounding(query);
    if (cached) {
        console.log(`Grounding cache hit for "${query}"`);
        return cached;
    }

    try {
        const command = new ConverseCommand({
            modelId: groundingModelId,
            messages: [
                {
                    role: "user",
                    content: [{ text: query }],
                },
            ],
            toolConfig: {
                tools: [{ systemTool: { name: "nova_grounding" } }],
            },
        });

        const response = await bedrockClient.send(command);
        const contentList = response.output?.message?.content || [];

        let text = "";
        const citations = [];

        for (const block of contentList) {
            if (block.text) text += block.text;
            if (block.citationsContent?.citations) {
                for (const citation of block.citationsContent.citations) {
                    if (citation.location?.web) {
                        citations.push({
                            url: citation.location.web.url,
                            domain: citation.location.web.domain || "",
                        });
                    }
                }
            }
        }

        const result = {
            query,
            summary: (text || "No results found.").substring(0, 2000),
            citations,
        };

        setCachedGrounding(query, result);
        return result;
    } catch (err) {
        console.error("Web grounding error:", err.message);
        return {
            query,
            summary: `Web grounding search failed: ${err.message}`,
            citations: [],
        };
    }
}

module.exports = { performWebGrounding };
