const { ConverseCommand } = require("@aws-sdk/client-bedrock-runtime");

async function summarizeMeetingTranscript(transcript, bedrockClient, groundingModelId) {
    const command = new ConverseCommand({
        modelId: groundingModelId,
        messages: [
            {
                role: "user",
                content: [
                    {
                        text: `Summarize the following meeting transcript into a structured report with these sections:
- **Meeting Summary**: 2-3 sentence overview
- **Key Discussion Points**: bullet points of main topics
- **Action Items**: specific tasks and owners if mentioned
- **Decisions Made**: any decisions reached

Transcript:
${transcript}`,
                    },
                ],
            },
        ],
    });

    const response = await bedrockClient.send(command);
    const contentList = response.output?.message?.content || [];
    let summary = "";
    for (const block of contentList) {
        if (block.text) summary += block.text;
    }
    return summary || "Failed to generate summary.";
}

module.exports = { summarizeMeetingTranscript };
