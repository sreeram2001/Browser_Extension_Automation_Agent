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

let ws = null;
let mediaStream = null;
let audioContext = null;
let processorNode = null;
let isRecording = false;
let playbackContext = null;
let nextPlayTime = 0;

// Audio config matching Nova Sonic expectations
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

micBtn.addEventListener("click", toggleRecording);

async function toggleRecording() {
    if (isRecording) {
        stopRecording();
    } else {
        await startRecording();
    }
}

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

        // Set up AudioContext for capture
        audioContext = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
        const source = audioContext.createMediaStreamSource(mediaStream);

        // Use ScriptProcessorNode (widely supported) for capturing raw PCM
        const bufferSize = 2048;
        processorNode = audioContext.createScriptProcessor(bufferSize, 1, 1);

        // Set up playback context
        playbackContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
        nextPlayTime = 0;

        // Connect WebSocket
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${protocol}//${location.host}`);

        ws.onopen = () => {
            statusEl.textContent = "Connected. Speak now...";
            ws.send(JSON.stringify({ type: "start" }));

            // Start sending audio
            source.connect(processorNode);
            processorNode.connect(audioContext.destination);

            processorNode.onaudioprocess = (e) => {
                if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;

                const float32 = e.inputBuffer.getChannelData(0);
                const int16 = float32ToInt16(float32);
                const base64 = arrayBufferToBase64(int16.buffer);

                ws.send(JSON.stringify({ type: "audio", data: base64 }));

                // Update visualizer
                updateVisualizer(float32);
            };
        };

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);

            if (msg.type === "audio") {
                playAudio(msg.data);
            } else if (msg.type === "text") {
                addTranscript(msg.role, msg.content);
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
        micBtn.classList.add("active");
    } catch (err) {
        statusEl.textContent = `Mic error: ${err.message}`;
        console.error(err);
    }
}

function stopRecording() {
    isRecording = false;
    micBtn.classList.remove("active");
    statusEl.textContent = "Click the mic to start talking";

    // Reset visualizer
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
}

function playAudio(base64Data) {
    if (!playbackContext) return;

    const raw = atob(base64Data);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

    // Convert Int16 PCM to Float32
    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
    }

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

function addTranscript(role, content) {
    if (!content || content.trim() === "") return;
    // Skip interrupted markers
    if (content.includes('"interrupted"')) return;

    const roleLabel = role === "USER" ? "You" : "Assistant";
    const cssClass = role === "USER" ? "user" : "assistant";

    const div = document.createElement("div");
    div.className = `msg ${cssClass}`;
    div.innerHTML = `<span class="label">${roleLabel}</span>${escapeHtml(content)}`;
    transcriptEl.appendChild(div);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

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
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function updateVisualizer(float32) {
    const step = Math.floor(float32.length / bars.length);
    for (let i = 0; i < bars.length; i++) {
        let sum = 0;
        for (let j = 0; j < step; j++) {
            sum += Math.abs(float32[i * step + j]);
        }
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
