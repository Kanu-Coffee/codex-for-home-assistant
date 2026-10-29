import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync, chmodSync, readFileSync, renameSync, realpathSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_HOLD_BYTES = 32 * 1024 * 1024;
const MAX_STREAM_BUFFER_BYTES = 64 * 1024 * 1024;
const MAX_BUFFER_BYTES = MAX_FRAME_BYTES;

function parseJsonMessages(buffer) {
  const messages = [];
  let remaining = buffer;
  while (true) {
    const newlineIndex = remaining.indexOf("\n");
    if (newlineIndex === -1) {
      break;
    }
    const line = remaining.slice(0, newlineIndex).trim();
    remaining = remaining.slice(newlineIndex + 1);
    if (!line) continue;
    try {
      const parsed = JSON.parse(line);
      messages.push({ raw: line + "\n", obj: parsed });
    } catch {
      // Non-JSON or incomplete line, keep scanning
    }
  }
  return { messages, remaining };
}

function getProcessStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const end = stat.lastIndexOf(")");
    if (end < 0) return "0";
    return stat.slice(end + 1).trim().split(/\s+/)[19] || "0";
  } catch {
    return "0";
  }
}

function isZombie(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    const end = stat.lastIndexOf(")");
    return end >= 0 && ["Z", "X"].includes(stat.slice(end + 1).trim().split(/\s+/)[0]);
  } catch { return false; }
}

export class StdioRelay {
  constructor({
    childExe,
    childArgs = [],
    childCwd = process.cwd(),
    childEnv = process.env,
    controlSocketPath,
    sessionFilePath,
    startTime = null,
    initialVersion = "0.162.1",
    sessionType = "remote-stdio",
    clientSocketPath = null,
    clientPid = null,
    spawnClient = false,
    clientArgs = [],
  }) {
    this.childExe = childExe;
    this.childArgs = childArgs;
    this.childCwd = childCwd;
    this.childEnv = childEnv;
    this.controlSocketPath = controlSocketPath;
    this.sessionFilePath = sessionFilePath ? sessionFilePath.replace(/%(PID|pid)%|\$(PID|pid)/g, String(process.pid)) : null;
    this.startTime = startTime || getProcessStartTime(process.pid);
    this.currentVersion = initialVersion;
    this.sessionType = sessionType;
    this.clientSocketPath = clientSocketPath;
    this.clientPid = clientPid;
    this.spawnClient = spawnClient;
    this.clientArgs = clientArgs;

    this.child = null;
    this.childStartTime = null;
    this.controlServer = null;
    this.clientServer = null;
    this.clientSocket = null;
    this.wsSocket = null;
    this.wsServer = null;
    this.wsFrameBuf = Buffer.alloc(0);
    this.wsFragment = null;
    this._wsSendText = null;
    this.clientProc = null;

    // Work tracking ledger
    this.inFlightClientRequests = new Map(); // id -> { method, time }
    this.pendingTurnStarts = new Map();      // id -> { threadId, time }
    this.activeTurnIds = new Set();          // turnId
    this.pendingServerRequests = new Map();  // id -> { method, time }
    this.threadStatuses = new Map();      // threadId -> idle, active or unknown
    this.unobservedWork = new Set();      // operations whose lifetime cannot be proven
    this.recoveryIncomplete = false;
    this.loadedThreadIds = new Set();        // client-visible threadId string

    // Thread ID mapping for transparent empty thread re-creation across worker switches
    this.clientToServerThreadMap = new Map(); // clientThreadId -> current serverThreadId
    this.serverToClientThreadMap = new Map(); // current serverThreadId -> clientThreadId
    this.emptyThreadParams = new Map();       // clientThreadId -> thread/start params
    // IDs only; never retain prompt or turn contents in the relay.
    this.threadsWithObservedTurns = new Set();
    this.pendingThreadStarts = new Map();     // requestId -> params

    // Internal RPC interceptor during switch
    this.internalPendingRpcs = new Map();    // id -> { resolve, reject }
    this.expiredInternalRpcIds = new Set();
    this.internalRpcPrefix = `__relay_internal_${process.pid}_${Math.random().toString(36).slice(2, 9)}_`;
    this.internalRpcCounter = 0;

    // Admission barrier & bounded hold
    this.barrier = false;
    this.heldClientChunks = [];
    this.heldBytes = 0;

    this.childGeneration = 0;
    this.activeGeneration = 0;

    this.clientBuffer = "";
    this.serverBuffer = "";
    this.closing = false;

    this.clientDecoder = new StringDecoder("utf-8");
    this.serverDecoder = new StringDecoder("utf-8");
    this.clientInitParams = null;

    // Command queue for strict serialization
    this.commandQueue = Promise.resolve();
  }

  _mapThreadId(clientThreadId, serverThreadId) {
    const oldServerId = this.clientToServerThreadMap.get(clientThreadId);
    if (oldServerId && oldServerId !== serverThreadId) {
      this.serverToClientThreadMap.delete(oldServerId);
    }
    this.clientToServerThreadMap.set(clientThreadId, serverThreadId);
    this.serverToClientThreadMap.set(serverThreadId, clientThreadId);
  }

  async start({ attachStdio = true } = {}) {
    this._startControlServer();
    await this._spawnChild(this.childExe, this.childArgs, this.childCwd, this.childEnv);
    if (this.clientSocketPath) {
      await this._startClientSocketServer();
    } else if (attachStdio) {
      this._setupClientIo();
    }
    this._writeSessionFile();

    if (this.spawnClient && this.clientSocketPath) {
      const clientProc = spawn(this.childExe, ["--remote", `unix://${this.clientSocketPath}`, ...this.clientArgs], {
        stdio: "inherit",
        env: this.childEnv,
        cwd: this.childCwd,
      });
      this.clientProc = clientProc;
      this.clientPid = clientProc.pid;
      this._writeSessionFile();
      clientProc.on("exit", (code) => {
        this.closing = true;
        this._cleanup();
        process.exit(code || 0);
      });
    }
  }

  _startClientSocketServer() {
    return new Promise((resolve, reject) => {
      try {
        if (existsSync(this.clientSocketPath)) unlinkSync(this.clientSocketPath);
      } catch {}

      // Helper: compute WebSocket accept key
      const wsAcceptKey = (clientKey) =>
        createHash("sha1")
          .update(clientKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          .digest("base64");

      // Helper: write a WebSocket text frame (server→client, no masking)
      const wsSendText = (sock, text) => {
        if (!sock || sock.destroyed) return false;
        const payload = Buffer.from(text, "utf-8");
        const len = payload.length;
        let header;
        if (len < 126) {
          header = Buffer.allocUnsafe(2);
          header[0] = 0x81; // FIN + text opcode
          header[1] = len;
        } else if (len < 65536) {
          header = Buffer.allocUnsafe(4);
          header[0] = 0x81;
          header[1] = 126;
          header.writeUInt16BE(len, 2);
        } else {
          header = Buffer.allocUnsafe(10);
          header[0] = 0x81;
          header[1] = 127;
          header.writeBigUInt64BE(BigInt(len), 2);
        }
        return sock.write(Buffer.concat([header, payload]));
      };

      // Helper: send pong frame
      const wsSendPong = (sock, payload) => {
        if (!sock || sock.destroyed) return;
        const len = payload.length;
        let header;
        if (len < 126) {
          header = Buffer.allocUnsafe(2);
          header[0] = 0x8a; // FIN + pong opcode
          header[1] = len;
        } else if (len < 65536) {
          header = Buffer.allocUnsafe(4);
          header[0] = 0x8a;
          header[1] = 126;
          header.writeUInt16BE(len, 2);
        } else {
          header = Buffer.allocUnsafe(10);
          header[0] = 0x8a;
          header[1] = 127;
          header.writeBigUInt64BE(BigInt(len), 2);
        }
        try { sock.write(Buffer.concat([header, payload])); } catch {}
      };

      // Helper: send close frame
      const wsSendClose = (sock) => {
        if (!sock || sock.destroyed) return;
        const frame = Buffer.from([0x88, 0x00]);
        try { sock.write(frame); } catch {}
      };

      // Helper: parse and dispatch incoming WS frames from a buffer
      // Returns the unconsumed remainder
      const parseWsFrames = (buf) => {
        while (buf.length >= 2) {
          const firstByte = buf[0];
          const secondByte = buf[1];
          const fin = (firstByte & 0x80) !== 0;
          const opcode = firstByte & 0x0f;
          const masked = (secondByte & 0x80) !== 0;
          let payloadLen = secondByte & 0x7f;
          let offset = 2;

          if (payloadLen === 126) {
            if (buf.length < 4) break; // need more data
            payloadLen = buf.readUInt16BE(2);
            offset = 4;
          } else if (payloadLen === 127) {
            if (buf.length < 10) break;
            payloadLen = buf.readUInt32BE(2) * 0x100000000 + buf.readUInt32BE(6);
            offset = 10;
          }

          if (payloadLen > MAX_FRAME_BYTES) {
            this._fatalTransportError("client_ws", "frame_exceeded_max_frame_bytes", payloadLen);
            return Buffer.alloc(0);
          }

          const maskLen = masked ? 4 : 0;
          const totalLen = offset + maskLen + payloadLen;
          if (buf.length < totalLen) {
            if (buf.length > MAX_STREAM_BUFFER_BYTES) {
              this._fatalTransportError("client_ws", "stream_buffer_overflow", buf.length);
              return Buffer.alloc(0);
            }
            break; // incomplete frame
          }

          let payload = buf.subarray(offset + maskLen, totalLen);
          if (masked) {
            const mask = buf.subarray(offset, offset + 4);
            payload = Buffer.from(payload); // copy
            for (let i = 0; i < payload.length; i++) {
              payload[i] ^= mask[i & 3];
            }
          }
          buf = buf.subarray(totalLen);

          const sock = this.wsSocket;

          if (opcode === 0x8) {
            // Close
            wsSendClose(sock);
            this.closing = true;
            this._cleanup();
            process.exit(0);
          } else if (opcode === 0x9) {
            // Ping → pong
            wsSendPong(sock, payload);
          } else if (opcode === 0xa) {
            // Pong → ignore
          } else if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
            // Text, binary, or continuation frame
            const text = payload.toString("utf-8");
            if (opcode === 0x0) {
              // Continuation
              if (this.wsFragment !== null) {
                this.wsFragment += text;
              }
            } else {
              // New message (possibly first fragment)
              this.wsFragment = text;
            }
            if (this.wsFragment !== null) {
              const fragLen = Buffer.byteLength(this.wsFragment, "utf-8");
              if (fragLen > MAX_FRAME_BYTES) {
                this._fatalTransportError("client_ws", "fragment_exceeded_max_frame_bytes", fragLen);
                return Buffer.alloc(0);
              }
            }
            if (fin && this.wsFragment !== null) {
              let msg = this.wsFragment;
              this.wsFragment = null;
              if (!msg.endsWith("\n")) msg += "\n";
              this._handleClientData(msg);
            }
          }
        }
        return buf;
      };

      this._wsSendText = (text) => wsSendText(this.wsSocket, text);

      const handleUpgrade = (req, socket, head) => {
        // Enforce single-client ownership
        if (this.wsSocket && !this.wsSocket.destroyed) {
          socket.write("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }

        const key = req.headers["sec-websocket-key"];
        const upgradeHeader = req.headers["upgrade"];
        if (!key || !upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
          socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }

        const acceptKey = wsAcceptKey(key);
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
        );

        this.wsSocket = socket;
        this.clientSocket = socket;
        this.wsFrameBuf = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
        this.wsFragment = null;

        if (this.wsFrameBuf.length > 0) {
          this.wsFrameBuf = parseWsFrames(this.wsFrameBuf);
        }

        socket.on("data", (chunk) => {
          this.wsFrameBuf = Buffer.concat([this.wsFrameBuf, chunk]);
          this.wsFrameBuf = parseWsFrames(this.wsFrameBuf);
        });

        socket.on("end", () => {
          this.closing = true;
          this._cleanup();
          process.exit(0);
        });

        socket.on("error", () => {
          if (this.wsSocket === socket) this.wsSocket = null;
          if (this.clientSocket === socket) this.clientSocket = null;
          this.closing = true;
          this._cleanup();
          process.exit(0);
        });

        // Flush any held chunks now that client is connected
        if (this.heldClientChunks.length > 0 && !this.barrier) {
          this._flushHeldClientChunks();
        }
      };

      this.wsServer = createHttpServer();
      this.wsServer.on("upgrade", handleUpgrade);
      this.wsServer.on("request", (req, res) => {
        res.writeHead(400, { Connection: "close" });
        res.end();
      });
      this.wsServer.on("error", reject);
      this.wsServer.listen(this.clientSocketPath, () => {
        try { chmodSync(this.clientSocketPath, 0o700); } catch {}
        resolve();
      });

      this.clientServer = this.wsServer;
    });
  }

  _writeSessionFile() {
    if (!this.sessionFilePath) return;
    let tmp;
    try {
      const data = {
        pid: process.pid,
        start: String(this.startTime),
        type: this.sessionType,
        managed: true,
        socketPath: this.clientSocketPath || "",
        controlSocket: this.controlSocketPath,
        workerPid: this.child ? this.child.pid : null,
        workerStart: this.child ? this.childStartTime : null,
        clientPid: this.clientPid || null,
        exe: this.childExe,
        version: this.currentVersion,
        cwd: this.childCwd,
        args: this.childArgs,
      };
      tmp = `${this.sessionFilePath}.tmp.${process.pid}.${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf-8", mode: 0o600 });
      renameSync(tmp, this.sessionFilePath);
    } catch (err) {
      if (tmp) try { unlinkSync(tmp); } catch {}
      throw err;
    }
  }

  _startControlServer() {
    if (!this.controlSocketPath) return;
    try {
      if (existsSync(this.controlSocketPath)) {
        unlinkSync(this.controlSocketPath);
      }
    } catch {}

    this.controlServer = createServer((sock) => {
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          this.commandQueue = this.commandQueue.then(async () => {
            try {
              const req = JSON.parse(line.trim());
              const res = await this._handleControlCommand(req);
              sock.write(JSON.stringify(res) + "\n");
            } catch (err) {
              sock.write(JSON.stringify({ error: err.message, busy: true }) + "\n");
            }
          });
        }
      });
    });

    this.controlServer.listen(this.controlSocketPath, () => {
      try {
        chmodSync(this.controlSocketPath, 0o600);
      } catch {}
    });
  }

  async _handleControlCommand(req) {
    const cmd = req.cmd;
    if (cmd === "inspect") {
      if (!this.child || this.child.exitCode !== null || this.child.signalCode || isZombie(this.child.pid) ||
          !this.childStartTime || this.childStartTime === "0" ||
          getProcessStartTime(this.child.pid) !== this.childStartTime) {
        return {
          busy: true,
          unknown: true,
          reason: "worker_not_running",
          workerPid: null,
          relayPid: process.pid,
          version: this.currentVersion,
          inFlight: this.inFlightClientRequests.size + this.pendingTurnStarts.size,
          pending: this.pendingServerRequests.size,
          activeTurns: this._workState().active,
          loadedThreads: Array.from(this.loadedThreadIds),
          exe: this.childExe,
        };
      }
      const work = this._workState();
      return {
        busy: work.busy,
        unknown: work.unknown,
        reason: work.unknown ? "session_activity_unverified" : null,
        inFlight: this.inFlightClientRequests.size + this.pendingTurnStarts.size,
        pending: this.pendingServerRequests.size,
        activeTurns: work.active,
        loadedThreads: Array.from(this.loadedThreadIds),
        workerPid: this.child ? this.child.pid : null,
        workerStart: this.child ? this.childStartTime : null,
        relayPid: process.pid,
        version: this.currentVersion,
        exe: this.childExe,
      };
    }

    if (cmd === "barrier") {
      if (!req.enabled && this.recoveryIncomplete) {
        return { error: "rollback_incomplete", success: false, barrier: true };
      }
      this.barrier = Boolean(req.enabled);
      if (!this.barrier) {
        this._flushHeldClientChunks();
      }
      return { success: true, barrier: this.barrier };
    }

    if (cmd === "switch_worker") {
      return await this.switchWorker(req);
    }

    return { error: `unknown command: ${cmd}`, busy: true };
  }

  _workState() {
    const statuses = [...this.threadStatuses.values()];
    const childDead = Boolean(
      !this.child ||
      typeof this.child.exitCode === "number" ||
      Boolean(this.child.signalCode) ||
      (this.child.pid && (!existsSync(`/proc/${this.child.pid}`) || isZombie(this.child.pid)))
    );
    const unknown = this.recoveryIncomplete || this.unobservedWork.size > 0 || statuses.includes("unknown") || childDead;
    const active = Math.max(this.activeTurnIds.size, statuses.filter((s) => s === "active").length);
    const hasPartialClientFrame = Boolean(
      (this.clientBuffer && this.clientBuffer.length > 0) ||
      (this.clientDecoder && this.clientDecoder.lastNeed > 0)
    );
    const hasPartialServerFrame = Boolean(
      (this.serverBuffer && this.serverBuffer.length > 0) ||
      (this.serverDecoder && this.serverDecoder.lastNeed > 0)
    );
    const hasPartialFrame = hasPartialClientFrame || hasPartialServerFrame;
    return {
      unknown,
      active,
      hasPartialFrame,
      hasPartialClientFrame,
      hasPartialServerFrame,
      busy: unknown || active > 0 || this.inFlightClientRequests.size > 0 ||
        this.pendingServerRequests.size > 0 || this.pendingTurnStarts.size > 0 ||
        hasPartialFrame,
    };
  }

  _setThreadStatus(threadId, status) {
    if (typeof threadId !== "string" || !threadId) {
      this.unobservedWork.add("invalid_thread_status");
      return;
    }
    const type = typeof status === "string" ? status : status?.type;
    if (type === "notLoaded") {
      this.threadStatuses.delete(threadId);
      this.loadedThreadIds.delete(threadId);
    } else if (type === "idle") {
      this.threadStatuses.set(threadId, "idle");
    } else if (type === "active") {
      this.threadStatuses.set(threadId, "active");
    } else {
      this.threadStatuses.set(threadId, "unknown");
    }
  }

  async _drainAndStopChild(timeoutMs = 5000) {
    const cleanupChild = (targetChild) => {
      if (targetChild) {
        try {
          targetChild.stdout.removeAllListeners("data");
        } catch {}
      }
      this.child = null;
      this.childStartTime = null;
      this.serverBuffer = "";
      this.serverDecoder = new StringDecoder("utf-8");
    };

    if (!this.child) {
      cleanupChild(null);
      return true;
    }
    const child = this.child;
    const pid = child.pid;

    // Check if child already exited
    if (child.exitCode !== null || child.signalCode || isZombie(pid) || !existsSync(`/proc/${pid}`)) {
      cleanupChild(child);
      return true;
    }

    if (!this.childStartTime || this.childStartTime === "0" ||
        getProcessStartTime(pid) !== this.childStartTime) {
      throw new Error("worker_identity_changed");
    }

    try { child.kill("SIGHUP"); } catch {}

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode || isZombie(pid) || !existsSync(`/proc/${pid}`)) {
        cleanupChild(child);
        return true;
      }
      if (getProcessStartTime(pid) !== this.childStartTime) throw new Error("worker_identity_changed");
      await new Promise((r) => setTimeout(r, 50));
    }

    if (existsSync(`/proc/${pid}`) && child.exitCode === null) {
      throw new Error(`drain_timeout: worker pid ${pid} did not terminate gracefully`);
    }

    cleanupChild(child);
    return true;
  }

  async switchWorker({ exe, version, args, cwd, env, keepBarrier = false }) {
    if (!exe || !version) {
      return { error: "missing exe or version", busy: true };
    }

    // Re-check busy right before starting switch
    if (this._workState().busy) {
      return { error: "worker_busy", busy: true };
    }

    // Set barrier to hold incoming client requests during transition
    this.barrier = true;

    // Verify persisted rollouts for any loaded threads before stopping worker.
    // Unpersisted / newly created empty threads without rollouts do not block switchWorker.
    const threadsToResume = [];
    const emptyThreads = [];
    try {
      for (const threadId of this.loadedThreadIds) {
        const serverThreadId = this.clientToServerThreadMap.get(threadId) || threadId;
        const read = await this._sendInternalRpc("thread/read", { threadId: serverThreadId }, 5000);

        if (!this.child || this.child.exitCode !== null || this.child.signalCode ||
            isZombie(this.child.pid) || !this.childStartTime ||
            getProcessStartTime(this.child.pid) !== this.childStartTime) {
          throw new Error("worker_identity_unavailable");
        }

        const thread = read?.result?.thread;
        const knownEmpty = this.emptyThreadParams.has(threadId) &&
          !this.threadsWithObservedTurns.has(threadId);
        if (thread?.id === serverThreadId && thread.ephemeral === true &&
            thread.path == null && Array.isArray(thread.turns) && thread.turns.length === 0) {
          if (!knownEmpty) throw new Error("ephemeral_history_unverified");
          emptyThreads.push({
            clientThreadId: threadId,
            params: { ...(this.emptyThreadParams.get(threadId) || { cwd: thread.cwd, model: thread.model }), ephemeral: true },
          });
          continue;
        }
        if (thread && thread.id === serverThreadId && typeof thread.path === "string") {
          const sessionsRoot = realpathSync(join(this.childEnv.CODEX_HOME || "/data/codex", "sessions"));
          let file = null;
          let realPath = null;
          try {
            const p = resolve(thread.path);
            file = lstatSync(p);
            realPath = realpathSync(p);
          } catch (fsErr) {
            if (fsErr.code === "ENOENT" && knownEmpty && (!thread.turns || thread.turns.length === 0)) {
              emptyThreads.push({
                clientThreadId: threadId,
                params: this.emptyThreadParams.get(threadId) || { cwd: thread.cwd, model: thread.model },
              });
              continue;
            }
            throw new Error(`thread_stat_failed_${fsErr.code || "unknown"}`);
          }

          if (!realPath.startsWith(sessionsRoot + "/")) {
            throw new Error("thread_unsafe_path");
          }
          if (!file.isFile()) {
            throw new Error("thread_not_a_regular_file");
          }
          if (file.nlink !== 1) {
            throw new Error("thread_hardlink_detected");
          }
          if (file.size === 0) {
            if (knownEmpty && (!thread.turns || thread.turns.length === 0)) {
              emptyThreads.push({
                clientThreadId: threadId,
                params: this.emptyThreadParams.get(threadId) || { cwd: thread.cwd, model: thread.model },
              });
              continue;
            }
            throw new Error("thread_empty_corrupted_rollout");
          }
          threadsToResume.push(serverThreadId);
        } else {
          throw new Error("thread_metadata_unverified");
        }
      }
      if (this._workState().busy) throw new Error("worker_busy");
    } catch (e) {
      if (e.message === "worker_busy") {
        if (!keepBarrier) {
          this.barrier = false;
          this._flushHeldClientChunks();
        }
        return { error: "worker_busy", busy: true };
      }
      if (e.message === "worker_identity_unavailable" ||
          !this.child || this.child.exitCode !== null || this.child.signalCode ||
          isZombie(this.child.pid) || !this.childStartTime ||
          getProcessStartTime(this.child.pid) !== this.childStartTime) {
        this.recoveryIncomplete = true;
        return { error: "worker_identity_unavailable", busy: true, rollbackStatus: "rollback_incomplete" };
      }
      if (!keepBarrier) {
        this.barrier = false;
        this._flushHeldClientChunks();
      }
      return { error: "thread_restorability_unverified", busy: true, rollbackStatus: "restored" };
    }

    // Drain and stop current child completely
    try {
      await this._drainAndStopChild();
    } catch (err) {
      if (!keepBarrier) {
        this.barrier = false;
        this._flushHeldClientChunks();
      }
      return { error: err.message, busy: true };
    }

    const previousExe = this.childExe;
    const previousVersion = this.currentVersion;
    const previousArgs = this.childArgs;
    const previousCwd = this.childCwd;
    const previousEnv = this.childEnv;

    const rollback = async (originalError) => {
      try {
        await this._drainAndStopChild();
      } catch {
        // The new writer is still alive or its identity is uncertain. Never
        // start the previous writer, and do not release queued input.
        this.recoveryIncomplete = true;
        return { error: originalError, busy: true, rollbackStatus: "rollback_incomplete" };
      }
      this.childExe = previousExe;
      this.currentVersion = previousVersion;
      this.childArgs = previousArgs;
      this.childCwd = previousCwd;
      this.childEnv = previousEnv;
      let rollbackOk = false;
      try {
        await this._spawnChild(this.childExe, this.childArgs, this.childCwd, this.childEnv);
        await this._sendInternalRpc("initialize", this.clientInitParams || {
          clientInfo: { name: "codex-ha-relay", version: "1.0" },
          capabilities: {},
        }, 5000);
        this._sendInternalNotification("initialized", {});
        for (const origThreadId of threadsToResume) {
          await this._sendInternalRpc("thread/resume", { threadId: origThreadId }, 5000);
        }
        for (const empty of emptyThreads) {
          const startRes = await this._sendInternalRpc("thread/start", empty.params || {}, 5000);
          const newId = startRes?.result?.thread?.id;
          if (!newId) throw new Error("empty_thread_recreate_invalid_response");
          this._mapThreadId(empty.clientThreadId, newId);
        }
        this.loadedThreadIds = new Set([
          ...threadsToResume.map((id) => this.serverToClientThreadMap.get(id) || id),
          ...emptyThreads.map((e) => e.clientThreadId),
        ]);
        rollbackOk = true;
      } catch {}
      if (!rollbackOk) this.recoveryIncomplete = true;
      try { this._writeSessionFile(); } catch { rollbackOk = false; this.recoveryIncomplete = true; }
      if (!keepBarrier && rollbackOk) {
        this.barrier = false;
        this._flushHeldClientChunks();
      }
      return {
        error: originalError,
        busy: true,
        rollbackStatus: rollbackOk ? "restored" : "rollback_incomplete",
      };
    };

    this.childExe = exe;
    this.currentVersion = version;
    if (args) this.childArgs = args;
    if (cwd) this.childCwd = cwd;
    if (env) this.childEnv = env;

    // Spawn new worker
    try {
      await this._spawnChild(this.childExe, this.childArgs, this.childCwd, this.childEnv);
    } catch (err) {
      return await rollback(`spawn_failed: ${err.message}`);
    }

    // Handshake: send initialize RPC to new worker
    const initParams = this.clientInitParams || {
      clientInfo: { name: "codex-ha-relay", version: "1.0" },
      capabilities: {},
    };
    try {
      const initRes = await this._sendInternalRpc("initialize", initParams, 5000);
      if (initRes && initRes.error) {
        throw new Error(`initialize_error: ${initRes.error.message || JSON.stringify(initRes.error)}`);
      }
      this._sendInternalNotification("initialized", {});
    } catch (err) {
      return await rollback(`initialize_failed: ${err.message}`);
    }

    // If there were loaded threads with saved history, restore them by sending thread/resume
    if (threadsToResume.length > 0 && this.child && this.child.stdin.writable) {
      for (const threadId of threadsToResume) {
        try {
          await this._sendInternalRpc("thread/resume", { threadId }, 5000);
        } catch (err) {
          return await rollback(`resume_failed: ${err.message}`);
        }
      }
    }
    // Recreate empty threads without history
    if (emptyThreads.length > 0 && this.child && this.child.stdin.writable) {
      for (const empty of emptyThreads) {
        try {
          const startRes = await this._sendInternalRpc("thread/start", empty.params || {}, 5000);
          const newId = startRes?.result?.thread?.id;
          if (!newId) throw new Error("empty_thread_recreate_invalid_response");
          this._mapThreadId(empty.clientThreadId, newId);
        } catch (err) {
          return await rollback(`empty_thread_recreate_failed: ${err.message}`);
        }
      }
    }
    this.loadedThreadIds = new Set([
      ...threadsToResume.map((id) => this.serverToClientThreadMap.get(id) || id),
      ...emptyThreads.map((e) => e.clientThreadId),
    ]);

    // Update session record
    try { this._writeSessionFile(); } catch (err) {
      return await rollback(`session_record_failed: ${err.message}`);
    }

    // Release only after the identity record is durable.
    if (!keepBarrier) {
      this.barrier = false;
      this._flushHeldClientChunks();
    }

    return {
      success: true,
      workerPid: this.child ? this.child.pid : null,
      workerStart: this.child ? this.childStartTime : null,
      relayPid: process.pid,
      version: this.currentVersion,
    };
  }

  _sendInternalRpc(method, params, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin.writable) {
        return reject(new Error("child_not_writable"));
      }
      this.internalRpcCounter++;
      const id = `${this.internalRpcPrefix}${Date.now()}_${this.internalRpcCounter}`;
      const timer = setTimeout(() => {
        this.internalPendingRpcs.delete(id);
        this.expiredInternalRpcIds.add(id);
        reject(new Error(`internal_rpc_timeout: ${method}`));
      }, timeoutMs);

      this.internalPendingRpcs.set(id, (res) => {
        clearTimeout(timer);
        if (res && res.error) {
          reject(new Error(`internal_rpc_error_${method}: ${res.error.message || JSON.stringify(res.error)}`));
        } else {
          resolve(res);
        }
      });

      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.child.stdin.write(payload);
    });
  }

  _sendInternalNotification(method, params) {
    if (!this.child || !this.child.stdin.writable) return;
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    this.child.stdin.write(payload);
  }

  async _spawnChild(exe, args, cwd, env) {
    const generation = ++this.childGeneration;
    this.activeGeneration = generation;
    this.serverBuffer = "";
    this.serverDecoder = new StringDecoder("utf-8");

    return new Promise((resolve, reject) => {
      let settled = false;

      // Buffer to preserve startup output arriving before the 50ms readiness
      // window confirms the child is alive. We hold these bytes so they are
      // processed once `this.child` is set, not silently discarded.
      let pendingChunks = [];

      const child = spawn(exe, args, {
        cwd,
        env,
        stdio: ["pipe", "pipe", "inherit"],
      });

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          pendingChunks = [];
          reject(err);
        }
      });

      // Give spawn a moment to ensure it didn't exit immediately
      setTimeout(() => {
        if (!settled) {
          settled = true;
          this.child = child;
          this.childStartTime = getProcessStartTime(child.pid);
          if (this.childStartTime === "0") {
            pendingChunks = [];
            reject(new Error("worker_identity_unavailable"));
            return;
          }
          // Drain any startup output that arrived before this.child was set
          for (const c of pendingChunks) {
            if (this.activeGeneration === generation && this.child === child) {
              this._handleServerData(c);
            }
          }
          pendingChunks = [];
          resolve(child);
        }
      }, 50);

      child.stdout.on("data", (chunk) => {
        // Generation mismatch: stale old-worker data; discard.
        if (this.activeGeneration !== generation) {
          return;
        }
        if (!settled || this.child !== child) {
          // Child not yet confirmed alive — buffer the startup output.
          pendingChunks.push(chunk);
          return;
        }
        this._handleServerData(chunk);
      });

      child.on("exit", (code, signal) => {
        if (!settled) {
          settled = true;
          reject(new Error(`child_exited_early_with_code_${code}`));
          return;
        }
        if (this.closing) {
          process.exit(code || 0);
        }
      });
    });
  }

  _setupClientIo() {
    process.stdin.on("data", (chunk) => {
      this._handleClientData(chunk);
    });

    process.stdin.on("end", () => {
      this.closing = true;
      if (this.child) {
        try { this.child.kill("SIGHUP"); } catch {}
      }
      this._cleanup();
    });

    const onSig = () => {
      this.closing = true;
      if (this.child) {
        try { this.child.kill("SIGHUP"); } catch {}
      }
      this._cleanup();
      process.exit(0);
    };

    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
    process.on("SIGHUP", onSig);
  }

  _fatalTransportError(direction, reason, measuredBytes) {
    if (this.closing) return;
    this.closing = true;
    this.recoveryIncomplete = true;
    this.unobservedWork.add(`transport_fatal_${direction}_${reason}`);
    const safeDiag = `[codex-session-host] fatal transport error: ${reason} in ${direction} (measuredBytes=${measuredBytes}, limit=${MAX_FRAME_BYTES})`;
    console.error(safeDiag);
    try {
      this._cleanup();
    } catch {}
    process.exit(1);
  }

  _pauseClientInput() {
    if (this.wsSocket && !this.wsSocket.destroyed) {
      try { this.wsSocket.pause(); } catch {}
    } else if (this.clientSocket && !this.clientSocket.destroyed) {
      try { this.clientSocket.pause(); } catch {}
    } else if (!this.clientSocketPath) {
      try { process.stdin.pause(); } catch {}
    }
  }

  _resumeClientInput() {
    if (this.barrier) return;
    if (this.wsSocket && !this.wsSocket.destroyed) {
      try { this.wsSocket.resume(); } catch {}
    } else if (this.clientSocket && !this.clientSocket.destroyed) {
      try { this.clientSocket.resume(); } catch {}
    } else if (!this.clientSocketPath) {
      try { process.stdin.resume(); } catch {}
    }
  }

  _handleClientData(chunk) {
    if (this.barrier) {
      this.heldClientChunks.push(chunk);
      this.heldBytes += Buffer.byteLength(typeof chunk === "string" ? chunk : chunk, "utf-8");
      if (this.heldBytes >= MAX_HOLD_BYTES) {
        this._pauseClientInput();
      }
      return;
    }

    this._processAndForwardClientChunk(chunk);
  }

  _processAndForwardClientChunk(chunk) {
    if (this.closing) return;
    const text = typeof chunk === "string" ? chunk : this.clientDecoder.write(chunk);
    const chunkBytes = Buffer.byteLength(text, "utf-8");
    if (chunkBytes > MAX_STREAM_BUFFER_BYTES) {
      this._fatalTransportError("client", "stream_buffer_overflow", chunkBytes);
      return;
    }

    this.clientBuffer += text;
    const { messages, remaining } = parseJsonMessages(this.clientBuffer);
    this.clientBuffer = remaining;

    const remainingBytes = Buffer.byteLength(this.clientBuffer, "utf-8");
    if (remainingBytes > MAX_FRAME_BYTES) {
      this._fatalTransportError("client", "frame_exceeded_max_frame_bytes", remainingBytes);
      return;
    }

    for (let { raw, obj } of messages) {
      const msgBytes = Buffer.byteLength(raw, "utf-8");
      if (msgBytes > MAX_FRAME_BYTES) {
        this._fatalTransportError("client", "frame_exceeded_max_frame_bytes", msgBytes);
        return;
      }
      if (obj && typeof obj === "object") {
        if (obj.method === "initialize" && obj.params) {
          this.clientInitParams = obj.params;
        }
        if (obj.id !== undefined && obj.method === "thread/start") {
          this.pendingThreadStarts.set(obj.id, obj.params || {});
        }
        if (obj.method === "turn/start" && typeof obj.params?.threadId === "string") {
          this.threadsWithObservedTurns.add(obj.params.threadId);
        }

        // Transparently map client thread IDs to active server thread IDs
        let modified = false;
        if (obj.params && typeof obj.params === "object") {
          if (typeof obj.params.threadId === "string" && this.clientToServerThreadMap.has(obj.params.threadId)) {
            obj.params.threadId = this.clientToServerThreadMap.get(obj.params.threadId);
            modified = true;
          }
          if (obj.params.thread && typeof obj.params.thread.id === "string" && this.clientToServerThreadMap.has(obj.params.thread.id)) {
            obj.params.thread.id = this.clientToServerThreadMap.get(obj.params.thread.id);
            modified = true;
          }
        }
        if (modified) {
          raw = JSON.stringify(obj) + "\n";
        }

        if (obj.id !== undefined && obj.method) {
          if (obj.method === "turn/start") {
            this.pendingTurnStarts.set(obj.id, {
              threadId: obj.params?.threadId,
              time: Date.now(),
            });
          } else {
            this.inFlightClientRequests.set(obj.id, {
              method: obj.method,
              threadId: typeof obj.params?.threadId === "string" ? obj.params.threadId : null,
              time: Date.now(),
            });
          }
        } else if (obj.id !== undefined && (obj.result !== undefined || obj.error !== undefined)) {
          // Client response to a server request (e.g. approval answered)
          this.pendingServerRequests.delete(obj.id);
        }
      }

      // Forward ONLY complete, newline-delimited frames to the child worker
      if (this.child && this.child.stdin && this.child.stdin.writable) {
        const drained = this.child.stdin.write(raw);
        if (drained === false) {
          this._pauseClientInput();
          if (typeof this.child.stdin.once === "function") {
            this.child.stdin.once("drain", () => this._resumeClientInput());
          }
        }
      }
    }
  }

  _handleServerData(chunk) {
    if (this.closing) return;
    const text = typeof chunk === "string" ? chunk : this.serverDecoder.write(chunk);
    const chunkBytes = Buffer.byteLength(text, "utf-8");
    if (chunkBytes > MAX_STREAM_BUFFER_BYTES) {
      this._fatalTransportError("server", "stream_buffer_overflow", chunkBytes);
      return;
    }

    this.serverBuffer += text;
    const { messages, remaining } = parseJsonMessages(this.serverBuffer);
    this.serverBuffer = remaining;

    const remainingBytes = Buffer.byteLength(this.serverBuffer, "utf-8");
    if (remainingBytes > MAX_FRAME_BYTES) {
      this._fatalTransportError("server", "frame_exceeded_max_frame_bytes", remainingBytes);
      return;
    }

    let forwardChunks = [];

    for (let { raw, obj } of messages) {
      const msgBytes = Buffer.byteLength(raw, "utf-8");
      if (msgBytes > MAX_FRAME_BYTES) {
        this._fatalTransportError("server", "frame_exceeded_max_frame_bytes", msgBytes);
        return;
      }
      if (obj && typeof obj === "object") {
        // Check if this response belongs to an active internal RPC from switchWorker
        if (obj.id && this.internalPendingRpcs.has(obj.id)) {
          const handler = this.internalPendingRpcs.get(obj.id);
          this.internalPendingRpcs.delete(obj.id);
          if (handler) handler(obj);
          continue; // Do NOT forward internal responses to client stdout!
        }
        if (obj.id && this.expiredInternalRpcIds.has(obj.id)) {
          this.expiredInternalRpcIds.delete(obj.id);
          continue; // Drop late responses from expired internal RPCs
        }

        if (obj.id !== undefined && (obj.result !== undefined || obj.error !== undefined)) {
          // Record params for newly created threads
          if (this.pendingThreadStarts.has(obj.id)) {
            const startParams = this.pendingThreadStarts.get(obj.id);
            this.pendingThreadStarts.delete(obj.id);
            if (obj.result?.thread?.id) {
              this.emptyThreadParams.set(obj.result.thread.id, startParams);
            }
          }

          // Check if this was a turn/start request response
          if (this.pendingTurnStarts.has(obj.id)) {
            const turnInfo = this.pendingTurnStarts.get(obj.id);
            this.pendingTurnStarts.delete(obj.id);
            if (obj.result?.turn?.id) {
              const status = obj.result.turn.status;
              if (status === "inProgress" || status === "active" || !status) {
                this.activeTurnIds.add(obj.result.turn.id);
              }
            }
          }

          // Check if this was an inFlight request
          if (this.inFlightClientRequests.has(obj.id)) {
            const req = this.inFlightClientRequests.get(obj.id);
            this.inFlightClientRequests.delete(obj.id);

            // Codex TUI's temporary title task explicitly unsubscribes after
            // completion. Only retire a thread created by our own managed
            // frontend with the exact temporary start contract and a verified
            // successful unsubscribe; analytics labels alone are insufficient.
            if (req.method === "thread/unsubscribe" && obj.result && this.sessionType === "cli" &&
                this.spawnClient && this.clientProc && req.threadId &&
                ["unsubscribed", "notLoaded"].includes(obj.result.status)) {
              const id = this.serverToClientThreadMap.get(req.threadId) || req.threadId;
              const params = this.emptyThreadParams.get(id);
              if (params?.ephemeral === true && params.threadSource === "thread_title" &&
                  this.threadStatuses.get(id) === "idle" && this.activeTurnIds.size === 0) {
                this.loadedThreadIds.delete(id);
                this.threadStatuses.delete(id);
                this.emptyThreadParams.delete(id);
                this.threadsWithObservedTurns.delete(id);
              }
            }

            // Only methods that load a thread establish a live subscription.
            if (obj.result && ["thread/start", "thread/resume", "thread/fork"].includes(req.method)) {
              const thread = obj.result.thread;
              if (typeof thread?.id === "string") {
                this.loadedThreadIds.add(thread.id);
                this._setThreadStatus(thread.id, thread.status);
              } else {
                this.unobservedWork.add("invalid_loaded_thread");
              }
            }
            if (obj.result && (req.method === "thread/unload" || req.method === "thread/close" || req.method === "thread/delete" || req.method === "thread/archive")) {
              if (req.threadId) {
                this.loadedThreadIds.delete(req.threadId);
                this.threadStatuses.delete(req.threadId);
              }
            }
            // These calls can leave work running after the response. Until a
            // version-specific authoritative lifecycle is implemented, defer.
            if (obj.result && ["thread/goal/set", "thread/shellCommand", "command/exec", "process/spawn"].includes(req.method)) {
              this.unobservedWork.add("background_work_unverified");
            }
          }
        } else if (obj.id !== undefined && obj.method) {
          // Server request to client (approval, input prompt)
          this.pendingServerRequests.set(obj.id, {
            method: obj.method,
            time: Date.now(),
          });
        }

        // Notification turns
        if (obj.method === "turn/started") {
          const serverThreadId = obj.params?.threadId;
          if (typeof serverThreadId === "string") {
            this.threadsWithObservedTurns.add(this.serverToClientThreadMap.get(serverThreadId) || serverThreadId);
          }
          const turnId = obj.params?.turn?.id || obj.params?.turnId;
          if (typeof turnId === "string" && turnId) this.activeTurnIds.add(turnId);
          else this.unobservedWork.add("invalid_turn_event");
        } else if (
          obj.method === "turn/completed" ||
          obj.method === "turn/interrupted" ||
          obj.method === "turn/failed"
        ) {
          if (obj.params?.turnId) {
            this.activeTurnIds.delete(obj.params.turnId);
          }
          if (obj.params?.turn?.id) {
            this.activeTurnIds.delete(obj.params.turn.id);
          }
        } else if (obj.method === "thread/started") {
          const thread = obj.params?.thread;
          if (typeof thread?.id === "string" && thread.id) {
            this.loadedThreadIds.add(thread.id);
            this._setThreadStatus(thread.id, thread.status);
          } else {
            this.unobservedWork.add("invalid_loaded_thread");
          }
        } else if (obj.method === "thread/goal/updated") {
          this.unobservedWork.add("background_work_unverified");
        } else if (obj.method === "thread/status/changed") {
          this._setThreadStatus(obj.params?.threadId, obj.params?.status);
        } else if (obj.method === "thread/closed") {
          const threadId = obj.params?.threadId;
          if (typeof threadId === "string") {
            this.loadedThreadIds.delete(threadId);
            this.threadStatuses.delete(threadId);
          }
        }

        // Remap server thread IDs back to client thread IDs in responses and events
        let modified = false;
        if (obj.result?.thread?.id && this.serverToClientThreadMap.has(obj.result.thread.id)) {
          const clientId = this.serverToClientThreadMap.get(obj.result.thread.id);
          obj.result.thread.id = clientId;
          if (obj.result.thread.sessionId) obj.result.thread.sessionId = clientId;
          modified = true;
        }
        if (obj.result?.turn?.threadId && this.serverToClientThreadMap.has(obj.result.turn.threadId)) {
          obj.result.turn.threadId = this.serverToClientThreadMap.get(obj.result.turn.threadId);
          modified = true;
        }
        if (obj.params?.threadId && this.serverToClientThreadMap.has(obj.params.threadId)) {
          obj.params.threadId = this.serverToClientThreadMap.get(obj.params.threadId);
          modified = true;
        }
        if (obj.params?.thread?.id && this.serverToClientThreadMap.has(obj.params.thread.id)) {
          const clientId = this.serverToClientThreadMap.get(obj.params.thread.id);
          obj.params.thread.id = clientId;
          if (obj.params.thread.sessionId) obj.params.thread.sessionId = clientId;
          modified = true;
        }
        if (obj.params?.turn?.threadId && this.serverToClientThreadMap.has(obj.params.turn.threadId)) {
          obj.params.turn.threadId = this.serverToClientThreadMap.get(obj.params.turn.threadId);
          modified = true;
        }
        if (modified) {
          raw = JSON.stringify(obj) + "\n";
        }
      }

      forwardChunks.push(raw);
    }

    if (forwardChunks.length > 0) {
      if (this.wsSocket && !this.wsSocket.destroyed && this._wsSendText) {
        for (const chunk of forwardChunks) {
          const drained = this._wsSendText(chunk);
          if (drained === false && this.child?.stdout) {
            try { this.child.stdout.pause(); } catch {}
            if (typeof this.wsSocket.once === "function") {
              this.wsSocket.once("drain", () => {
                try { this.child?.stdout?.resume(); } catch {}
              });
            }
          }
        }
      } else if (this.clientSocket && this.clientSocket.writable) {
        const drained = this.clientSocket.write(forwardChunks.join(""));
        if (drained === false && this.child?.stdout) {
          try { this.child.stdout.pause(); } catch {}
          if (typeof this.clientSocket.once === "function") {
            this.clientSocket.once("drain", () => {
              try { this.child?.stdout?.resume(); } catch {}
            });
          }
        }
      } else if (!this.clientSocketPath) {
        process.stdout.write(forwardChunks.join(""));
      }
    }
  }

  _flushHeldClientChunks() {
    this._resumeClientInput();
    const chunks = this.heldClientChunks;
    this.heldClientChunks = [];
    this.heldBytes = 0;
    for (const chunk of chunks) {
      this._processAndForwardClientChunk(chunk);
    }
  }

  _cleanup() {
    if (this.wsSocket) {
      try { this.wsSocket.destroy(); } catch {}
      this.wsSocket = null;
    }
    if (this.wsServer) {
      try { this.wsServer.close(); } catch {}
      this.wsServer = null;
    }
    if (this.clientSocket) {
      try { this.clientSocket.destroy(); } catch {}
      this.clientSocket = null;
    }
    if (this.clientServer) {
      try { this.clientServer.close(); } catch {}
      this.clientServer = null;
    }
    if (this.clientProc) {
      try { this.clientProc.kill("SIGTERM"); } catch {}
      this.clientProc = null;
    }
    if (this.clientSocketPath) {
      try {
        if (existsSync(this.clientSocketPath)) unlinkSync(this.clientSocketPath);
      } catch {}
    }
    try { process.stdin.pause(); } catch {}
    if (this.child) {
      try { this.child.stdin?.end(); } catch {}
      try { this.child.kill("SIGHUP"); } catch {}
      try { this.child.kill("SIGTERM"); } catch {}
      this.child = null;
    }
    if (this.controlServer) {
      try { this.controlServer.close(); } catch {}
    }
    if (this.controlSocketPath) {
      try {
        if (existsSync(this.controlSocketPath)) unlinkSync(this.controlSocketPath);
      } catch {}
    }
    if (this.sessionFilePath) {
      try {
        if (existsSync(this.sessionFilePath)) unlinkSync(this.sessionFilePath);
      } catch {}
    }
  }
}

// Standalone runner when invoked directly from CLI
export async function main() {
  const args = process.argv.slice(2);
  let controlSocket = null;
  let sessionFile = null;
  let startTime = null;
  let childExe = null;
  let version = "0.162.1";
  let sessionType = "remote-stdio";
  let clientSocket = null;
  let clientPid = null;
  let spawnClient = false;
  let clientArgs = [];
  let childArgs = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--control-socket" && args[i + 1]) {
      controlSocket = args[i + 1];
      i++;
    } else if (args[i] === "--session-file" && args[i + 1]) {
      sessionFile = args[i + 1];
      i++;
    } else if (args[i] === "--start-time" && args[i + 1]) {
      startTime = args[i + 1];
      i++;
    } else if (args[i] === "--version" && args[i + 1]) {
      version = args[i + 1];
      i++;
    } else if (args[i] === "--type" && args[i + 1]) {
      sessionType = args[i + 1];
      i++;
    } else if (args[i] === "--client-socket" && args[i + 1]) {
      clientSocket = args[i + 1];
      i++;
    } else if (args[i] === "--client-pid" && args[i + 1]) {
      clientPid = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--spawn-client") {
      spawnClient = true;
    } else if (args[i] === "--client-args" && args[i + 1]) {
      try { clientArgs = JSON.parse(args[i + 1]); } catch {}
      i++;
    } else if (args[i] === "--exe" && args[i + 1]) {
      childExe = args[i + 1];
      i++;
    } else if (args[i] === "--") {
      childArgs = args.slice(i + 1);
      break;
    }
  }

  if (!childExe) {
    console.error("codex-session-host: --exe is required");
    process.exit(1);
  }

  const relay = new StdioRelay({
    childExe,
    childArgs,
    controlSocketPath: controlSocket,
    sessionFilePath: sessionFile,
    startTime,
    initialVersion: version,
    sessionType,
    clientSocketPath: clientSocket,
    clientPid,
    spawnClient,
    clientArgs,
  });

  await relay.start();
}

if (process.argv[1] && process.argv[1].endsWith("codex-session-host.mjs")) {
  main().catch((err) => {
    console.error("Fatal in codex-session-host:", err);
    process.exit(1);
  });
}
