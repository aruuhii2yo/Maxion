"use strict";
// Runs lambda.js's AWS Lambda handler as a standalone container process.
//
// lambda.js exports only `handler(event, context)` in API Gateway v2 /
// Lambda Function URL shape -- there is no app.listen() in it, so `node
// lambda.js` alone loads the module and exits without ever binding a port.
// smithery.yaml's startCommand.type: http requires something listening on
// $PORT. This adapts raw Node HTTP requests into the same event shape AWS
// sends (matching the apiEvent() helper test_lambda.js already tests
// against) and writes the handler's {statusCode, headers, body} back out,
// so the container runs the exact code path AWS would run.
const http = require("http");
const { handler } = require("./lambda.js");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const [reqPath, queryString = ""] = req.url.split("?");
    const event = {
      requestContext: {
        http: {
          method: req.method,
          path: reqPath,
          sourceIp: req.socket.remoteAddress || "unknown",
        },
      },
      rawQueryString: queryString,
      headers: req.headers,
      body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined,
      isBase64Encoded: false,
    };

    try {
      const result = await handler(event, { callbackWaitsForEmptyEventLoop: false });
      res.writeHead(result.statusCode, result.headers || {});
      res.end(result.body || "");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Maxion MCP Gateway listening on port ${PORT}`);
});
