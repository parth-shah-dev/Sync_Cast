(() => {
  const $ = (id) => document.getElementById(id);
  const el = {
    room: $("roomCode"), connect: $("connectBtn"), disconnect: $("disconnectBtn"),
    statusDot: $("statusDot"), statusText: $("statusText"), peerDot: $("peerDot"), peerStatus: $("peerStatus"),
    transport: $("transportLabel"), fileInput: $("fileInput"), video: $("video"), placeholder: $("videoPlaceholder"),
    fileState: $("fileState"), fileInfo: $("fileInfo"), sendFile: $("sendFileBtn"), sync: $("syncBtn"),
    autoSync: $("autoSync"), progressWrap: $("progressWrap"), progressLabel: $("progressLabel"),
    progressPct: $("progressPct"), progressBar: $("progressBar"), connectionStat: $("connectionStat"),
    playbackStat: $("playbackStat"), positionStat: $("positionStat"), hashStat: $("hashStat"),
    networkStat: $("networkStat"), log: $("log"), clearLog: $("clearLogBtn")
  };

  const CHUNK = 16 * 1024;
  const BUFFER_LIMIT = 1024 * 1024;
  const STUN = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];
  let ws = null, pc = null, dc = null, room = "", joined = false, isHost = false, peerOnline = false;
  let selectedFile = null, selectedHash = null, remoteOffer = null, incoming = null, localUrl = null;
  let pendingCandidates = [];
  let syncing = false, lastCommandAt = 0, lastDriftCorrection = 0, transferBusy = false;
  const seenCommands = new Set();

  function log(message) {
    const line = document.createElement("div");
    line.className = "log-line";
    const time = new Date().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit", second:"2-digit"});
    const stamp = document.createElement("span"); stamp.className = "time"; stamp.textContent = time;
    line.append(stamp, document.createTextNode(message)); el.log.prepend(line);
    while (el.log.children.length > 80) el.log.lastChild.remove();
  }
  function setStatus(text, online = false) {
    el.statusText.textContent = text;
    el.statusDot.classList.toggle("muted", !online);
    el.connectionStat.textContent = online ? "Connected" : "Offline";
  }
  function peerStatus(text, online = false) {
    el.peerStatus.textContent = text; el.peerDot.classList.toggle("muted", !online);
  }
  function setProgress(label, done, total) {
    el.progressWrap.classList.remove("hidden");
    const pct = total ? Math.min(100, Math.floor(done / total * 100)) : 0;
    el.progressLabel.textContent = label; el.progressPct.textContent = pct + "%"; el.progressBar.style.width = pct + "%";
    if (total && done >= total) setTimeout(() => el.progressWrap.classList.add("hidden"), 1800);
  }
  function fmt(seconds) {
    if (!Number.isFinite(seconds)) return "00:00";
    seconds = Math.max(0, Math.floor(seconds));
    return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
  }
  async function hashFile(file) {
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  }
  function sendSignal(payload) {
    if (ws && ws.readyState === WebSocket.OPEN && joined) ws.send(JSON.stringify(payload));
  }
  function sendData(obj) {
    if (dc && dc.readyState === "open") dc.send(JSON.stringify(obj));
  }
  function isConnected() { return dc && dc.readyState === "open"; }

  async function connect() {
    room = el.room.value.trim().toUpperCase();
    if (!room) return alert("Enter a room code first.");
    if (!window.crypto || !crypto.subtle) return alert("Secure cryptography is unavailable. Open this app on localhost or an HTTPS host.");
    el.connect.disabled = true; setStatus("Connecting to room…");
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
    ws.onopen = () => { ws.send(JSON.stringify({ type: "join", room })); log("Connected to signaling server; joining room " + room + "."); };
    ws.onmessage = async (event) => {
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === "joined") {
        joined = true; isHost = msg.peerCount === 1; el.disconnect.disabled = false; el.connect.disabled = true;
        setStatus("In room · waiting for peer"); log("Joined room " + msg.room + ". Share the code with your friend.");
      } else if (msg.type === "peer-joined") {
        peerOnline = true; peerStatus("Friend is in the room", true); log("Friend joined the room.");
        if (!pc) createPeerConnection();
        // The server notifies only the existing peer, so this peer initiates
        // WebRTC negotiation exactly once.
        if (!pc.remoteDescription && pc.signalingState === "stable") {
          isHost = true;
          await makeOffer();
        }
      } else if (msg.type === "peer-left") {
        peerOnline = false; peerStatus("Friend disconnected"); log("Friend left the room.");
      } else if (msg.type === "signal") {
        await handleSignal(msg.payload);
      } else if (msg.type === "error") {
        log("Room error: " + msg.message); alert(msg.message); disconnect();
      }
    };
    ws.onerror = () => { log("Signaling connection failed. The server must be reachable over HTTPS/WSS for public use."); setStatus("Signaling error"); el.connect.disabled = false; };
    ws.onclose = () => { if (joined) log("Signaling connection closed."); joined = false; el.connect.disabled = false; };
  }

  function createPeerConnection() {
    pc = new RTCPeerConnection({ iceServers: STUN });
    pc.onicecandidate = (event) => { if (event.candidate) sendSignal({ type: "candidate", candidate: event.candidate }); };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      el.transport.textContent = "WebRTC: " + state;
      el.networkStat.textContent = state === "connected" ? "Peer-to-peer" : state;
      if (state === "connected") { setStatus("Peer connected", true); log("WebRTC connected. Media files are not streamed during playback."); }
      if (state === "failed") log("Direct connection failed. This MVP needs a TURN relay for some NAT/firewall combinations.");
      if (state === "disconnected") log("Peer connection temporarily disconnected.");
    };
    pc.ondatachannel = (event) => { dc = event.channel; configureDataChannel(); };
  }

  async function makeOffer() {
    if (!pc || pc.signalingState !== "stable") return;
    isHost = true;
    if (!dc) { dc = pc.createDataChannel("syncscreen", { ordered: true }); configureDataChannel(); }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendSignal({ type: "offer", sdp: pc.localDescription });
    log("Sent connection offer.");
  }
  async function handleSignal(msg) {
    if (!msg || !msg.type) return;
    if (msg.type === "offer") {
      if (!pc) createPeerConnection();
      isHost = false;
      await pc.setRemoteDescription(msg.sdp);
      for (const candidate of pendingCandidates) { try { await pc.addIceCandidate(candidate); } catch (e) { log("ICE candidate warning: " + e.message); } }
      pendingCandidates = [];
      const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
      sendSignal({ type: "answer", sdp: pc.localDescription });
      log("Accepted connection offer.");
    } else if (msg.type === "answer" && pc && !pc.currentRemoteDescription) {
      await pc.setRemoteDescription(msg.sdp);
      for (const candidate of pendingCandidates) { try { await pc.addIceCandidate(candidate); } catch (e) { log("ICE candidate warning: " + e.message); } }
      pendingCandidates = [];
      log("Received connection answer.");
    } else if (msg.type === "candidate" && pc) {
      if (!pc.remoteDescription) { pendingCandidates.push(msg.candidate); }
      else { try { await pc.addIceCandidate(msg.candidate); } catch (e) { log("ICE candidate warning: " + e.message); } }
    }
  }

  function configureDataChannel() {
    if (!dc) return;
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = BUFFER_LIMIT / 2;
    dc.onopen = () => {
      setStatus("Peer connected", true); peerStatus("Friend connected", true);
      el.sync.disabled = false; el.sendFile.disabled = !selectedFile;
      el.networkStat.textContent = "Peer-to-peer"; el.transport.textContent = "WebRTC data channel open";
      log("Peer data channel open. Sending only sync/file data, not live movie frames.");
      sendData({ type: "hello", version: 1 });
      if (selectedFile && selectedHash) announceFile();
    };
    dc.onclose = () => { setStatus("Peer disconnected"); el.sync.disabled = true; el.sendFile.disabled = true; log("Data channel closed."); };
    dc.onerror = () => log("Data channel error.");
    dc.onmessage = onDataMessage;
  }

  async function announceFile() {
    if (!selectedFile || !selectedHash) return;
    sendData({ type: "file-offer", name: selectedFile.name, size: selectedFile.size, hash: selectedHash, mime: selectedFile.type || "video/mp4" });
  }

  async function onDataMessage(event) {
    if (typeof event.data !== "string") {
      if (!incoming) return;
      incoming.parts.push(event.data); incoming.received += event.data.byteLength;
      setProgress("Receiving " + incoming.name, incoming.received, incoming.size);
      if (incoming.received >= incoming.size) await finishIncoming();
      return;
    }
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    switch (msg.type) {
      case "hello": log("Friend's player is ready."); if (selectedFile) announceFile(); break;
      case "file-offer":
        remoteOffer = msg;
        if (selectedFile && selectedHash === msg.hash) {
          sendData({ type: "file-match", hash: msg.hash }); log("Both PCs have matching copies: " + msg.name); el.hashStat.textContent = "Match verified";
        } else {
          log("Friend offered " + msg.name + " (" + humanSize(msg.size) + "). Requesting transfer because no matching local copy is selected.");
          sendData({ type: "request-file", hash: msg.hash });
        }
        break;
      case "file-match":
        if (selectedHash === msg.hash) { el.hashStat.textContent = "Match verified"; log("Friend confirmed the same SHA-256 file."); }
        transferBusy = false; el.sendFile.disabled = !selectedFile || !isConnected();
        break;
      case "request-file":
        if (selectedFile && selectedHash === msg.hash && !transferBusy) await sendFileToPeer();
        break;
      case "file-start":
        incoming = { name: msg.name, size: msg.size, hash: msg.hash, mime: msg.mime || "video/mp4", parts: [], received: 0 };
        setProgress("Receiving " + msg.name, 0, msg.size); log("Receiving " + msg.name + " (" + humanSize(msg.size) + ").");
        break;
      case "file-end": if (incoming && incoming.received >= incoming.size) await finishIncoming(); break;
      case "sync": await applySync(msg); break;
      case "sync-request": if (isHost) sendSyncState(); break;
      case "transfer-error": log("Transfer error: " + msg.message); transferBusy = false; break;
      default: break;
    }
  }

  async function finishIncoming() {
    if (!incoming || incoming.finishing) return;
    incoming.finishing = true;
    const fileData = incoming;
    try {
      const blob = new Blob(fileData.parts, { type: fileData.mime });
      if (blob.size !== fileData.size) throw new Error("Received size does not match the offered file.");
      const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
      const actualHash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
      if (actualHash !== fileData.hash) throw new Error("SHA-256 verification failed; file may be corrupted.");
      const file = new File([blob], fileData.name, { type: fileData.mime, lastModified: Date.now() });
      setSelectedFile(file, actualHash, true);
      el.hashStat.textContent = "SHA-256 verified";
      el.fileInfo.textContent = "Received and verified " + file.name + " (" + humanSize(file.size) + "). The file is ready for local playback in this tab.";
      log("Transfer complete. Size and SHA-256 verified for " + file.name + ".");
      sendData({ type: "file-match", hash: actualHash });
    } catch (error) {
      log("File verification failed: " + error.message); el.hashStat.textContent = "Verification failed";
      alert("The received file could not be verified: " + error.message);
    } finally {
      incoming = null; transferBusy = false;
      setProgress("Transfer finished", fileData.size, fileData.size);
      el.sendFile.disabled = !selectedFile || !isConnected();
    }
  }

  function waitForBuffer() {
    if (!dc || dc.readyState !== "open") return Promise.reject(new Error("Peer connection closed."));
    if (dc.bufferedAmount < BUFFER_LIMIT) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Transfer stalled; connection may have dropped.")), 30000);
      dc.addEventListener("bufferedamountlow", () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  async function sendFileToPeer() {
    if (!selectedFile || !selectedHash || !isConnected() || transferBusy) return;
    transferBusy = true; el.sendFile.disabled = true;
    const file = selectedFile, hash = selectedHash;
    try {
      sendData({ type: "file-start", name: file.name, size: file.size, hash, mime: file.type || "video/mp4" });
      let sent = 0;
      while (sent < file.size) {
        await waitForBuffer();
        if (!isConnected()) throw new Error("Connection closed during transfer.");
        const chunk = await file.slice(sent, Math.min(sent + CHUNK, file.size)).arrayBuffer();
        dc.send(chunk); sent += chunk.byteLength;
        if (sent % (CHUNK * 32) === 0 || sent === file.size) setProgress("Sending " + file.name, sent, file.size);
      }
      sendData({ type: "file-end", hash });
      log("File transfer sent: " + file.name + " (" + humanSize(file.size) + "). Waiting for receiver verification.");
    } catch (error) {
      sendData({ type: "transfer-error", message: error.message }); log("Transfer stopped: " + error.message);
      transferBusy = false; el.sendFile.disabled = !selectedFile || !isConnected();
    }
  }

  function setSelectedFile(file, hash, received = false) {
    selectedFile = file; selectedHash = hash;
    if (localUrl) URL.revokeObjectURL(localUrl);
    localUrl = URL.createObjectURL(file); el.video.src = localUrl;
    el.placeholder.classList.add("hidden");
    el.fileState.textContent = file.name;
    el.fileInfo.textContent = file.name + " · " + humanSize(file.size) + " · SHA-256 " + hash.slice(0, 12) + "…";
    el.hashStat.textContent = received ? "SHA-256 verified" : "SHA-256 calculated";
    el.sendFile.disabled = !isConnected();
    log((received ? "Loaded received file: " : "Loaded local file: ") + file.name + ". SHA-256 calculated.");
    if (isConnected()) announceFile();
  }
  function humanSize(bytes) {
    if (!Number.isFinite(bytes)) return "unknown size";
    const units = ["B", "KB", "MB", "GB"]; let n = bytes, i = 0;
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return n.toFixed(i ? 1 : 0) + " " + units[i];
  }

  function sendSyncState() {
    if (!isConnected()) return;
    sendData({ type: "sync", id: crypto.randomUUID(), action: "state", time: el.video.currentTime || 0, paused: el.video.paused, rate: el.video.playbackRate, sentAt: Date.now() });
  }
  function sendAction(action, extra = {}) {
    if (!isConnected() || syncing) return;
    sendData({ type: "sync", id: crypto.randomUUID(), action, time: el.video.currentTime || 0, paused: el.video.paused, rate: el.video.playbackRate, sentAt: Date.now(), ...extra });
  }
  async function applySync(msg) {
    if (msg.id && seenCommands.has(msg.id)) return;
    if (msg.id) { seenCommands.add(msg.id); if (seenCommands.size > 200) seenCommands.delete(seenCommands.values().next().value); }
    if (!el.video.src || !Number.isFinite(msg.time)) return;
    syncing = true;
    try {
      const target = Math.max(0, msg.time + (msg.paused ? 0 : Math.max(0, (Date.now() - msg.sentAt) / 1000)));
      const drift = target - el.video.currentTime;
      const baseRate = msg.rate || 1;
      el.video.playbackRate = baseRate;
      if (msg.action === "state" || msg.action === "seek" || Math.abs(drift) > 1.2) {
        el.video.currentTime = target;
      } else if (Math.abs(drift) > 0.18 && el.autoSync.checked) {
        el.video.currentTime = target;
      } else if (el.autoSync.checked && !msg.paused && Math.abs(drift) > 0.045) {
        el.video.playbackRate = Math.max(0.94, Math.min(1.06, baseRate + (drift > 0 ? 0.025 : -0.025)));
        setTimeout(() => {
          if (el.video) { syncing = true; el.video.playbackRate = baseRate; syncing = false; }
        }, 1500);
      }
      if (msg.paused) el.video.pause(); else await el.video.play().catch(() => {});
      log("Synced playback: " + msg.action + " · drift " + drift.toFixed(2) + "s.");
    } catch (error) { log("Sync warning: " + error.message); }
    finally { syncing = false; }
  }

  el.connect.addEventListener("click", connect);
  el.disconnect.addEventListener("click", disconnect);
  el.clearLog.addEventListener("click", () => el.log.replaceChildren());
  el.fileInput.addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0]; if (!file) return;
    el.fileInfo.textContent = "Calculating SHA-256…"; el.fileState.textContent = "Checking file…"; el.hashStat.textContent = "Hashing…";
    try { const hash = await hashFile(file); setSelectedFile(file, hash); }
    catch (error) { log("Could not hash file: " + error.message); alert("Could not read this file in the browser."); }
  });
  el.sendFile.addEventListener("click", sendFileToPeer);
  el.sync.addEventListener("click", sendSyncState);
  el.video.addEventListener("play", () => { el.playbackStat.textContent = "Playing"; if (!syncing) sendAction("play"); });
  el.video.addEventListener("pause", () => { el.playbackStat.textContent = "Paused"; if (!syncing) sendAction("pause"); });
  el.video.addEventListener("seeking", () => { if (!syncing) sendAction("seek"); });
  el.video.addEventListener("ratechange", () => { if (!syncing) sendAction("rate"); });
  el.video.addEventListener("timeupdate", () => { el.positionStat.textContent = fmt(el.video.currentTime); });
  el.video.addEventListener("loadedmetadata", () => { el.placeholder.classList.add("hidden"); el.playbackStat.textContent = "Ready"; });
  el.video.addEventListener("error", () => {
    if (selectedFile) { el.fileInfo.textContent = "This browser could not play this format. Try an MP4 encoded with H.264 video and AAC audio."; log("Browser cannot decode this movie format. File transfer can still work."); }
  });
  setInterval(() => {
    if (!isConnected()) return;
    if (!isHost && !el.video.paused && el.autoSync.checked && Date.now() - lastDriftCorrection > 2500) {
      lastDriftCorrection = Date.now(); sendData({ type: "sync-request" });
    }
  }, 2500);

  function disconnect() {
    if (dc) { try { dc.close(); } catch {} dc = null; }
    if (pc) { try { pc.close(); } catch {} pc = null; }
    if (ws) { try { ws.close(); } catch {} ws = null; }
    joined = false; peerOnline = false; isHost = false; transferBusy = false; incoming = null; pendingCandidates = [];
    el.connect.disabled = false; el.disconnect.disabled = true; el.sendFile.disabled = true; el.sync.disabled = true;
    el.transport.textContent = "WebRTC not ready"; el.networkStat.textContent = "Not connected";
    setStatus("Not connected"); peerStatus("Waiting for the other person");
    log("Disconnected.");
  }
  window.addEventListener("beforeunload", () => { if (localUrl) URL.revokeObjectURL(localUrl); });
  log("Ready. Start the signaling server, then connect both computers using the same room code.");
})();