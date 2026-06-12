/**
 * Step-1 spike (PLN — Event-Driven Comment Watch): prove the MCP SDK can serve
 * Streamable HTTP from inside the plugin bundle. Go/no-go gate — not the real
 * server (that's step 4, after comments-core and the auth contracts exist).
 *
 * No "obsidian" imports here, so the same module can be bundled and exercised
 * in plain node (scripts/spike-smoke.mjs) before being loaded in the app.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
// Static import on purpose: esbuild compiles it to require("http"), which
// Obsidian's runtime resolves on desktop. (A dynamic import("http") survives
// as a native import() and fails in the renderer: "Failed to resolve module
// specifier".) Mobile safety comes from main.ts lazy-importing this whole
// module behind Platform.isDesktop.
import { createServer } from "http";
import type { IncomingMessage, Server, ServerResponse } from "http";

export const SPIKE_MCP_PORT = Number(process.env.ANNOTATED_SPIKE_PORT ?? 27191);
// Loopback for local desktop use; the container deploy sets
// ANNOTATED_SPIKE_HOST=0.0.0.0 so the reverse proxy can reach it.
export const SPIKE_MCP_HOST = process.env.ANNOTATED_SPIKE_HOST ?? "127.0.0.1";

export interface SpikeServerInfo {
  vaultName: string;
  pluginVersion: string;
}

export class SpikeMcpServer {
  private httpServer: Server | null = null;

  constructor(
    private readonly info: SpikeServerInfo,
    private readonly port: number = SPIKE_MCP_PORT,
    private readonly host: string = SPIKE_MCP_HOST,
  ) {}

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      this.route(req, res).catch((err) => {
        console.error("[annotated-spike] request failed", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        if (!res.writableEnded) {
          res.end(JSON.stringify({ error: "internal error" }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.httpServer = server;
  }

  async stop(): Promise<void> {
    const server = this.httpServer;
    if (!server) return;
    this.httpServer = null;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  get address(): string {
    return `http://${this.host}:${this.port}`;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (url.pathname === "/spike/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...this.info }));
      return;
    }

    if (url.pathname === "/mcp") {
      // Stateless mode: a fresh server+transport pair per request, no session
      // bookkeeping. Enough for the spike; the real server decides this in step 4.
      const mcp = this.buildMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      res.on("close", () => {
        transport.close();
        mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  }

  private buildMcpServer(): McpServer {
    const mcp = new McpServer({
      name: "obsidian-annotated-spike",
      version: this.info.pluginVersion,
    });
    mcp.registerTool(
      "hello",
      {
        title: "Hello from Obsidian",
        description:
          "Spike tool proving the MCP server runs inside the Annotated plugin",
        inputSchema: { name: z.string().optional() },
      },
      async ({ name }) => ({
        content: [
          {
            type: "text",
            text: `Hello ${name ?? "world"} — from obsidian-annotated v${this.info.pluginVersion}, vault "${this.info.vaultName}"`,
          },
        ],
      }),
    );
    return mcp;
  }
}
