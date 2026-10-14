const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 8080);
const PUBLIC = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml" };

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  const fullPath = path.resolve(PUBLIC, "." + requested);
  if (!fullPath.startsWith(PUBLIC + path.sep) && fullPath !== path.join(PUBLIC, "index.html")) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(fullPath)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
const rooms = new Map();

wss.on("connection", (socket) => {
  socket.room = null;
  socket.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "join" && typeof msg.room === "string") {
      const room = msg.room.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 32);
      if (!room) return;
      if (socket.room && rooms.has(socket.room)) rooms.get(socket.room).delete(socket);
      socket.room = room;
      if (!rooms.has(room)) rooms.set(room, new Set());
      const peers = rooms.get(room);
      if (peers.size >= 2) {
        socket.send(JSON.stringify({ type: "error", message: "This room already has two people." }));
        peers.delete(socket); socket.room = null; return;
      }
      peers.add(socket);
      socket.send(JSON.stringify({ type: "joined", room, peerCount: peers.size }));
      // Notify only the existing peer. That peer becomes the offerer;
      // the newly joined peer waits to receive the offer.
      for (const peer of peers) {
        if (peer !== socket && peer.readyState === 1) {
          peer.send(JSON.stringify({ type: "peer-joined" }));
        }
      }
      return;
    }
    if (!socket.room || !rooms.has(socket.room)) return;
    for (const peer of rooms.get(socket.room)) {
      if (peer !== socket && peer.readyState === 1) peer.send(JSON.stringify({ type: "signal", payload: msg }));
    }
  });
  socket.on("close", () => {
    if (!socket.room || !rooms.has(socket.room)) return;
    const peers = rooms.get(socket.room);
    peers.delete(socket);
    for (const peer of peers) if (peer.readyState === 1) peer.send(JSON.stringify({ type: "peer-left" }));
    if (!peers.size) rooms.delete(socket.room);
  });
});

server.listen(PORT, "0.0.0.0", () => console.log(`SyncScreen MVP listening on http://localhost:${PORT}`));
