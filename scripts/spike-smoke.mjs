/**
 * Step-1 spike smoke test (PLN — Event-Driven Comment Watch).
 *
 * Bundles src/mcp/SpikeMcpServer.ts with the same settings as the plugin build
 * (cjs, es2018, browser-ish platform, node builtins external), runs it in plain
 * node, then connects a real MCP client over Streamable HTTP and calls the
 * hello tool. Passing this proves the SDK survives the plugin's bundle
 * conditions; the in-Obsidian half of the gate is loading the plugin itself.
 *
 * Usage: node scripts/spike-smoke.mjs
 */
import esbuild from "esbuild";
import builtins from "builtin-modules";
import { createRequire } from "module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 27192;
const OUTFILE = new URL("../.spike/SpikeMcpServer.cjs", import.meta.url).pathname;

const nodePrefixExternal = {
  name: "node-prefix-external",
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => ({
      path: args.path.slice("node:".length),
      external: true,
    }));
  },
};

await esbuild.build({
  entryPoints: ["src/mcp/SpikeMcpServer.ts"],
  bundle: true,
  external: [...builtins],
  plugins: [nodePrefixExternal],
  format: "cjs",
  target: "es2018",
  outfile: OUTFILE,
});
console.log("bundled OK (same settings as plugin build)");

const require = createRequire(import.meta.url);
const { SpikeMcpServer } = require(OUTFILE);

const server = new SpikeMcpServer(
  { vaultName: "smoke-test-vault", pluginVersion: "0.0.0-spike" },
  PORT,
  "127.0.0.1",
);
await server.start();
console.log(`server up at ${server.address}/mcp`);

try {
  const health = await fetch(`${server.address}/spike/health`).then((r) => r.json());
  console.log("health:", JSON.stringify(health));

  const client = new Client({ name: "spike-smoke-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${server.address}/mcp`));
  await client.connect(transport);

  const tools = await client.listTools();
  console.log("tools:", tools.tools.map((t) => t.name).join(", "));

  const result = await client.callTool({ name: "hello", arguments: { name: "Deme" } });
  console.log("hello →", result.content[0].text);

  await client.close();

  const ok =
    tools.tools.some((t) => t.name === "hello") &&
    result.content[0].text.includes("smoke-test-vault");
  console.log(ok ? "SPIKE SMOKE: PASS" : "SPIKE SMOKE: FAIL");
  process.exitCode = ok ? 0 : 1;
} finally {
  await server.stop();
}
