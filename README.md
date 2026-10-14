# SyncScreen MVP

A prototype synchronized local movie player for two friends. Each person plays the movie locally; WebRTC carries playback commands and optional file transfer, not continuous movie frames.

## Requirements
- Node.js 18+
- Chrome or Edge on both computers for the easiest test
- An internet-accessible HTTPS deployment for use across Gujarat/Maharashtra (or a temporary secure tunnel during development)

## Run locally
```bash
npm install
npm start
```
Open http://localhost:8080 in two tabs to test. Enter the same room code in both tabs. Click Connect in both. One peer creates the WebRTC offer automatically after the second peer joins.

## Use over the public internet
The included Node server is a signaling server only. Deploy it to a public Node host with HTTPS/WSS support. Open the deployed URL on both computers, enter the same private room code, and connect.

This MVP uses public Google STUN servers. STUN often allows a direct peer-to-peer connection, but some carrier-grade NATs/firewalls require TURN. For reliable real-world use, configure a TURN service and add its `urls`, `username`, and `credential` to the `STUN`/ICE server list in `public/app.js`. Keep TURN credentials private and preferably issue short-lived credentials from your backend.

## File transfer and playback
- Choose a local video on either computer.
- The app calculates SHA-256 and announces the file metadata to the peer.
- If the peer has not selected an identical file, it automatically requests a transfer.
- The file is sent in 16 KiB chunks over an ordered WebRTC data channel.
- The receiver assembles the file in memory, verifies byte size and SHA-256, and loads it into the local video player.
- The peer can press “Sync playback now” to align position/state.
- Play, pause, seek and playback-rate changes are broadcast. Drift correction estimates network delay and nudges the receiver when needed.

## MVP limitations (important)
- This is a prototype, not production-ready.
- Incoming transfers are assembled in RAM and the received file is held in the page session. Very large files can exhaust memory; use smaller test videos first. A production desktop app should stream to disk using the File System Access API or native filesystem APIs and support resumable chunks.
- The room code is not authentication. Anyone who guesses it may join. Use a random code and only share it privately.
- A room supports two peers.
- No TURN server is bundled. Some internet connections will fail without TURN.
- Browser codecs vary. MP4 with H.264 video and AAC audio is the best first test. A browser may not play MKV/AVI even if the file transfers.
- Hashing reads the selected file into memory. This is fine for a prototype-sized video but should be changed to incremental hashing for large files.
- Sync accuracy is best-effort and depends on buffering, playback startup, codec support, and internet latency. Browsers may require a user click before remote playback can start.
- For copyright compliance, only transfer files you have the right to share.

## Architecture
- Browser UI + HTML5 `<video>`: local playback and file selection
- WebSocket signaling server: room membership and offer/answer/ICE forwarding
- WebRTC `RTCPeerConnection`: peer connectivity with STUN
- Ordered WebRTC data channel: JSON playback commands + binary file chunks
- SHA-256: verify received bytes match the offered file


## Deploy on Render
1. Push this project folder to a GitHub repository (do not commit `node_modules`).
2. In Render, create a new Blueprint and select the repository containing `render.yaml`, or create a Web Service with build command `npm install` and start command `npm start`.
3. Wait for deployment and open the HTTPS URL provided by Render.
4. Open that same URL on both PCs and use the same room code.
5. If WebRTC reports `failed`, configure a TURN service; STUN-only connectivity cannot work through every NAT/firewall.
