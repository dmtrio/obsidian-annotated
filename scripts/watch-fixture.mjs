// Fake actionable endpoint for test-watch-comments.sh: serves whatever the
// state file holds, requires the test bearer key. No plugin needed.
import { createServer } from "http";
import { readFileSync } from "fs";

const PORT = Number(process.argv[2] ?? 27999);
const STATE_FILE = process.argv[3];

createServer((req, res) => {
	const url = new URL(req.url ?? "/", "http://localhost");
	if (url.pathname !== "/comments/actionable") {
		res.writeHead(404).end();
		return;
	}
	if (req.headers.authorization !== "Bearer watch-fixture-secret") {
		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: "unauthorized" }));
		return;
	}
	let body = "[]";
	try {
		body = readFileSync(STATE_FILE, "utf8");
	} catch {
		// state not written yet → empty set
	}
	res.writeHead(200, { "content-type": "application/json" });
	res.end(body);
}).listen(PORT, "127.0.0.1", () => console.log(`fixture up on ${PORT}`));
