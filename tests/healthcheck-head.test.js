"use strict";

const assert = require("node:assert/strict");
const http = require("node:http");
const { ensureHttpServer } = require("../core/telegram-runtime");

(async () => {
  const previousPort = process.env.PORT;
  const previousSecret = process.env.WEBHOOK_SECRET;
  process.env.PORT = "0";
  delete process.env.WEBHOOK_SECRET;

  const server = await ensureHttpServer({});
  assert.ok(server, "HTTP server should start");
  const port = server.address().port;

  try {
    const getHealth = await request(port, "GET", "/health");
    assert.equal(getHealth.status, 200);
    assert.equal(getHealth.body, "borsa-gpt-bot ok");

    const headHealth = await request(port, "HEAD", "/health");
    assert.equal(headHealth.status, 200);
    assert.equal(headHealth.body, "");
    assert.equal(headHealth.headers["content-length"], getHealth.headers["content-length"]);

    const missing = await request(port, "HEAD", "/not-found");
    assert.equal(missing.status, 404);

    console.log("Health endpoint GET/HEAD routing tests: OK");
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
    if (previousSecret === undefined) delete process.env.WEBHOOK_SECRET;
    else process.env.WEBHOOK_SECRET = previousSecret;
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

function request(port, method, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on("error", reject);
    req.end();
  });
}
