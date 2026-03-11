const micBtn = document.getElementById("mic-btn");
const statusEl = document.getElementById("status");
const transcriptEl = document.getElementById("transcript");
const visualizerEl = document.getElementById("visualizer");

// Create visualizer bars
for (let i = 0; i < 20; i++) {
    const bar = document.createElement("div");
    bar.className = "bar";
    visualizerEl.appendChild(bar);
}
const bars = visualizerEl.querySelectorAll(".bar");

// ── State ──
let ws = null;
let mediaStream = null;
let audioContext = null;
let processorNode = null;
let isRecording = false;
let playbackContext = null;
let nextPlayTime = 0;
let silenceTimer = null;
let wakeWordRecognition = null;
let wakeWordActive = false;

const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;
const WAKE_PHRASE = "computer";
const SILENCE_TIMEOUT_MS = 10000; // end session after 10s of silence

// ── Wake Word Detection (Web Speech API) ──

function initWakeWord() {
    const SpeechRecognition =
        window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
        statusEl.textContent =
            "Wake word not supported in this browser. Use the mic button.";
        return;
    }

    wakeWordRecognition = new SpeechRecognition();
    wakeWordRecognition.continuous = true;
    wakeWordRecognition.interimResults = true;
    wakeWordRecognition.lang = "en-US";

    wakeWordRecognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript.toLowerCase().trim();
            console.log("[Wake word] Heard:", transcript);

            const variations = [WAKE_PHRASE];
            const matched = variations.some((v) => transcript.includes(v));
            console.log(matched)

            if (matched) {
                console.log("Wake word detected:", transcript);
                addSystemMessage("Wake word detected!");
                stopWakeWordListening();
                startRecording();
                return;
            }
        }
    };

    wakeWordRecognition.onerror = (event) => {
        console.warn("[Wake word] Error:", event.error);
        // Restart on recoverable errors
        if (event.error === "no-speech" || event.error === "aborted" || event.error === "network") {
            if (wakeWordActive && !isRecording) {
                setTimeout(() => {
                    try { wakeWordRecognition.start(); } catch (e) { }
                }, 300);
            }
        }
    };

    wakeWordRecognition.onend = () => {
        // Auto-restart if we're still in listening mode
        if (wakeWordActive && !isRecording) {
            try {
                wakeWordRecognition.start();
            } catch (e) {
                // already started
            }
        }
    };
}

function startWakeWordListening() {
    if (!wakeWordRecognition) return;
    wakeWordActive = true;
    micBtn.classList.remove("active");
    micBtn.classList.add("listening");
    statusEl.textContent = 'Listening for "Computer"...';
    try {
        wakeWordRecognition.start();
    } catch (e) {
        // already running
    }
}

function stopWakeWordListening() {
    wakeWordActive = false;
    micBtn.classList.remove("listening");
    if (wakeWordRecognition) {
        try {
            wakeWordRecognition.stop();
        } catch (e) {
            // not running
        }
    }
}

// ── Silence Detection ──

function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
        if (isRecording) {
            addSystemMessage("Agent stopped.");
            stopRecording();
        }
    }, SILENCE_TIMEOUT_MS);
}

function clearSilenceTimer() {
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
    }
}

// ── Mic Button ──

micBtn.addEventListener("click", () => {
    if (isRecording) {
        stopRecording();
    } else {
        stopWakeWordListening();
        startRecording();
    }
});

// ── Recording (Nova Sonic session) ──

async function startRecording() {
    try {
        statusEl.textContent = "Requesting microphone access...";

        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: INPUT_SAMPLE_RATE,
                channelCount: 1,
                echoCancellation: true,
                noiseSuppression: true,
            },
        });

        audioContext = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
        const source = audioContext.createMediaStreamSource(mediaStream);
        const bufferSize = 2048;
        processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

        playbackContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
        nextPlayTime = 0;

        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${protocol}//${location.host}`);

        ws.onopen = () => {
            statusEl.textContent = "Connected. Speak now...";
            ws.send(JSON.stringify({ type: "start" }));

            source.connect(processorNode);
            processorNode.connect(audioContext.destination);

            // Start silence timer
            resetSilenceTimer();

            processorNode.onaudioprocess = (e) => {
                if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;

                const float32 = e.inputBuffer.getChannelData(0);

                // Check if there's actual audio (not silence)
                let rms = 0;
                for (let i = 0; i < float32.length; i++) rms += float32[i] * float32[i];
                rms = Math.sqrt(rms / float32.length);
                if (rms > 0.01) resetSilenceTimer(); // voice detected, reset timer

                const int16 = float32ToInt16(float32);
                const base64 = arrayBufferToBase64(int16.buffer);
                ws.send(JSON.stringify({ type: "audio", data: base64 }));

                updateVisualizer(float32);
            };
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);

            if (msg.type === "audio") {
                resetSilenceTimer(); // model is responding, keep alive
                playAudio(msg.data);
            } else if (msg.type === "text") {
                resetSilenceTimer();
                addTranscript(msg.role, msg.content);
            } else if (msg.type === "tool_use") {
                resetSilenceTimer();
                addSystemMessage(`🔍 Searching the web...`);
            } else if (msg.type === "search_results") {
                resetSilenceTimer();
                addSearchResults(msg.query, msg.summary, msg.citations);
            } else if (msg.type === "error") {
                statusEl.textContent = `Error: ${msg.message}`;
            } else if (msg.type === "session_end") {
                statusEl.textContent = "Session ended.";
            }
        };

        ws.onerror = () => {
            statusEl.textContent = "WebSocket error. Check server.";
        };

        ws.onclose = () => {
            if (isRecording) stopRecording();
        };

        isRecording = true;
        micBtn.classList.remove("listening");
        micBtn.classList.add("active");
    } catch (err) {
        statusEl.textContent = `Mic error: ${err.message}`;
        console.error(err);
        startWakeWordListening();
    }
}

function stopRecording() {
    isRecording = false;
    micBtn.classList.remove("active");
    clearSilenceTimer();

    bars.forEach((b) => (b.style.height = "4px"));

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "stop" }));
        ws.close();
    }
    ws = null;

    if (processorNode) {
        processorNode.disconnect();
        processorNode = null;
    }
    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (mediaStream) {
        mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
    }

    // Go back to wake word listening
    startWakeWordListening();
}

// ── Audio Playback ──

function playAudio(base64Data) {
    if (!playbackContext) return;

    const raw = atob(base64Data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

    const buffer = playbackContext.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buffer.getChannelData(0).set(float32);

    const source = playbackContext.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackContext.destination);

    const now = playbackContext.currentTime;
    if (nextPlayTime < now) nextPlayTime = now;
    source.start(nextPlayTime);
    nextPlayTime += buffer.duration;
}

// ── Transcript ──

function addTranscript(role, content) {
    if (!content || content.trim() === "") return;
    if (content.includes('"interrupted"')) return;

    const roleLabel = role === "USER" ? "You" : "Assistant";
    const cssClass = role === "USER" ? "user" : "assistant";

    const div = document.createElement("div");
    div.className = `msg ${cssClass}`;
    div.innerHTML = `<span class="label">${roleLabel}</span>${escapeHtml(content)}`;
    transcriptEl.appendChild(div);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addSystemMessage(text) {
    const div = document.createElement("div");
    div.className = "msg system";
    div.textContent = text;
    transcriptEl.appendChild(div);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function addSearchResults(query, summary, citations) {
    const div = document.createElement("div");
    div.className = "msg search-results";

    let html = `<span class="label">🌐 Web Grounding</span>`;
    if (citations && citations.length > 0) {
        html += `<div class="citations">`;
        const uniqueUrls = [...new Map(citations.map((c) => [c.url, c])).values()];
        uniqueUrls.forEach((c) => {
            const domain = c.domain || new URL(c.url).hostname;
            html += `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener" class="citation-link">${escapeHtml(domain)}</a>`;
        });
        html += `</div>`;
    }

    div.innerHTML = html;
    transcriptEl.appendChild(div);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

// ── Utilities ──

function float32ToInt16(float32Array) {
    const int16 = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Array[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return int16;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

function updateVisualizer(float32) {
    const step = Math.floor(float32.length / bars.length);
    for (let i = 0; i < bars.length; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) sum += Math.abs(float32[i * step + j]);
        const avg = sum / step;
        const height = Math.max(4, Math.min(40, avg * 300));
        bars[i].style.height = `${height}px`;
    }
}

function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// ── Init ──

const enableBtn = document.getElementById("enable-btn");

enableBtn.addEventListener("click", async () => {
    // Request mic permission with a user gesture — this unlocks everything
    try {
        const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // Got permission, release the temp stream
        tempStream.getTracks().forEach((t) => t.stop());

        // Hide enable button, show mic button
        enableBtn.style.display = "none";
        micBtn.style.display = "flex";

        // Now start wake word listening (mic permission already granted)
        initWakeWord();
        startWakeWordListening();
    } catch (err) {
        statusEl.textContent = `Mic permission denied: ${err.message}`;
    }
});
