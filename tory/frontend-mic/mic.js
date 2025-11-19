let ws;
// mediaRecorder kept for compatibility variable name but not used in PCM flow
let mediaRecorder;
let audioContext;
let sourceNode;
let processorNode;
let localStream;

const log = (msg) => {
  document.getElementById("log").textContent += msg + "\n";
  console.log(msg);
};

document.getElementById("startBtn").onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    localStream = stream;
    log("🎤 Microfoon gestart...");

    // Open een WebSocket-verbinding (identical URL & behavior)
    ws = new WebSocket("wss://tory.chatystream.chat/ws");

    ws.onopen = () => {
      log("✅ WebSocket verbonden");

      // Create AudioContext and processing chain
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      sourceNode = audioContext.createMediaStreamSource(stream);

      const bufferSize = 4096; // approx. desired buffer size
      // create a processor with input channels equal to source channel count and 1 output channel
      processorNode = audioContext.createScriptProcessor(bufferSize, sourceNode.channelCount || 1, 1);

      // prevent audible feedback by routing through a zero-gain node
      const zeroGain = audioContext.createGain();
      zeroGain.gain.value = 0;

      processorNode.onaudioprocess = (event) => {
        const inputBuffer = event.inputBuffer;
        const numChannels = inputBuffer.numberOfChannels;
        const len = inputBuffer.length;

        // Downmix to mono by averaging channels
        const mono = new Float32Array(len);
        for (let ch = 0; ch < numChannels; ch++) {
          const channelData = inputBuffer.getChannelData(ch);
          for (let i = 0; i < len; i++) {
            mono[i] += channelData[i] / numChannels;
          }
        }

        // calculate RMS
        let sumSquares = 0;
        for (let i = 0; i < len; i++) {
          const s = mono[i];
          sumSquares += s * s;
        }
        const rms = Math.sqrt(sumSquares / len);

        // Downsample to 16 kHz and convert to 16-bit PCM
        const inputSampleRate = audioContext.sampleRate;
        // TEMP: Skip downsampling - send at native rate
        const pcm16 = floatTo16BitPCM(mono);

        // Debug: check if pcm16 has actual data
        if (!window.audioDebugLogged) {
          console.log('[DEBUG] PCM16 sample rate:', inputSampleRate, '-> 16000 Hz');
          console.log('[DEBUG] PCM16 array length:', pcm16.length);
          console.log('[DEBUG] PCM16 first 10 values:', Array.from(pcm16.slice(0, 10)));
          console.log('[DEBUG] PCM16 buffer byteLength:', pcm16.buffer.byteLength);
          console.log('[DEBUG] PCM16 byteLength:', pcm16.byteLength);
          const max = Math.max(...Array.from(pcm16).map(Math.abs));
          console.log('[DEBUG] PCM16 max absolute value:', max);
          window.audioDebugLogged = true;
        }

        if (ws && ws.readyState === WebSocket.OPEN) {
          try {
            // Send the Int16Array data directly (WebSocket will handle it as binary)
            ws.send(pcm16);
            log(`📦 Chunk verstuurd: ${pcm16.byteLength} bytes (16kHz)`);
            console.log(`PCM chunk: ${pcm16.byteLength} bytes, RMS: ${rms.toFixed(3)}, Sample rate: ${inputSampleRate}Hz -> 16kHz`);
          } catch (e) {
            console.error('Failed to send PCM chunk', e);
          }
        } else {
          console.log('WebSocket not open; skipping PCM chunk');
        }
      };

      // wire nodes: source -> processor -> zeroGain -> destination
      sourceNode.connect(processorNode);
      processorNode.connect(zeroGain);
      zeroGain.connect(audioContext.destination);
    };

    ws.onclose = () => log("❌ WebSocket gesloten");
    ws.onerror = (err) => log("⚠️ WebSocket fout: " + (err && err.message ? err.message : err));
    
    // Handle incoming messages (transcripts, pings, etc.)
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        
        if (data.type === "transcript") {
          const prefix = data.isFinal ? "📝 FINAL" : "💬 PARTIAL";
          log(`${prefix}: ${data.text}`);
          
          // Update transcript display area
          const transcriptDiv = document.getElementById("transcriptText");
          if (transcriptDiv) {
            if (data.isFinal) {
              // Append final transcript
              const finalSpan = document.createElement("div");
              finalSpan.className = "final";
              finalSpan.textContent = data.text;
              transcriptDiv.appendChild(finalSpan);
            } else {
              // Show partial transcript in place
              let partialSpan = transcriptDiv.querySelector(".partial");
              if (!partialSpan) {
                partialSpan = document.createElement("div");
                partialSpan.className = "partial";
                transcriptDiv.appendChild(partialSpan);
              }
              partialSpan.textContent = data.text;
            }
          }
        } else if (data.type === "ping") {
          // Heartbeat from server, ignore or log
          console.log("❤️ Server ping");
        } else if (data.type === "ack") {
          // Acknowledgment from server, can be ignored
          console.log("✓ Server ack");
        }
      } catch (err) {
        console.error("Failed to parse WebSocket message:", err);
      }
    };

    document.getElementById("startBtn").disabled = true;
    document.getElementById("stopBtn").disabled = false;
  } catch (err) {
    log("🚫 Fout bij microfoon: " + err.message);
  }
};

document.getElementById("stopBtn").onclick = () => {
  // Stop ScriptProcessor / AudioContext if present
  try {
    if (processorNode) {
      processorNode.disconnect();
      processorNode.onaudioprocess = null;
      processorNode = null;
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch (e) { /* ignore */ }
      sourceNode = null;
    }
    if (audioContext) {
      audioContext.close();
      audioContext = null;
    }

    // stop all tracks
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }

    if (ws) {
      try { ws.close(); } catch (e) { /* ignore */ }
      ws = null;
    }

    // Clear transcript display
    const transcriptDiv = document.getElementById("transcriptText");
    if (transcriptDiv) {
      transcriptDiv.innerHTML = "Wachten op audio...";
    }

    log("🛑 Opname gestopt");
  } catch (err) {
    console.error('Error during stop', err);
  }

  document.getElementById("startBtn").disabled = false;
  document.getElementById("stopBtn").disabled = true;
};

// Helper: convert Float32Array [-1..1] to PCM16 Int16Array
function floatTo16BitPCM(float32Array) {
  const output = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Array[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

// Helper: downsample Float32 audio to 16 kHz and convert to PCM16
function downsampleTo16kHz(float32Array, inputSampleRate) {
  const targetSampleRate = 16000;
  
  // If already at 16kHz, just convert to PCM16
  if (inputSampleRate === targetSampleRate) {
    return floatTo16BitPCM(float32Array);
  }

  const sampleRateRatio = inputSampleRate / targetSampleRate;
  const newLength = Math.round(float32Array.length / sampleRateRatio);
  const downsampled = new Float32Array(newLength);

  let offsetResult = 0;
  let offsetBuffer = 0;
  
  while (offsetResult < newLength) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * sampleRateRatio);
    let accum = 0;
    let count = 0;
    
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < float32Array.length; i++) {
      accum += float32Array[i];
      count++;
    }
    
    downsampled[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }

  return floatTo16BitPCM(downsampled);
}
