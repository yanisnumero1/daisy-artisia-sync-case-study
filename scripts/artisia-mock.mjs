import { createServer } from "node:http";

const port = 4010;
const allowedScenarios = new Set(["success", "conflict", "error", "slow", "held"]);

let scenario = process.env.ARTISIA_MOCK_SCENARIO ?? "success";
let bookingRequestCount = 0;
let releaseBooking;

function sendJson(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const server = createServer(async (request, response) => {
  // Integration tests use this local-only route to change the mock behavior.
  if (request.method === "PUT" && request.url === "/__scenario") {
    try {
      const body = await readJson(request);

      if (!allowedScenarios.has(body.scenario)) {
        sendJson(response, 400, { error: "Unknown scenario" });
        return;
      }

      scenario = body.scenario;
      bookingRequestCount = 0;
      sendJson(response, 200, { scenario });
    } catch {
      sendJson(response, 400, { error: "Invalid JSON" });
    }

    return;
  }

  // A test-controlled barrier keeps the partner call open while a webhook arrives.
  if (request.method === "POST" && request.url === "/__release") {
    releaseBooking?.();
    releaseBooking = undefined;
    sendJson(response, 200, { released: true });
    return;
  }

  // This route lets tests verify that Daisy did not retry a booking POST.
  if (request.method === "GET" && request.url === "/__state") {
    sendJson(response, 200, {
      scenario,
      bookingRequestCount,
    });
    return;
  }

  const isBookingRequest =
    request.method === "POST" &&
    /^\/v1\/sessions\/[^/]+\/bookings$/.test(request.url ?? "");

  if (!isBookingRequest) {
    response.writeHead(404);
    response.end();
    return;
  }

  if (request.headers.authorization !== "Bearer test-api-key") {
    sendJson(response, 401, { error: "Invalid API key" });
    return;
  }

  bookingRequestCount += 1;
  const bookingNumber = bookingRequestCount;
  const requestScenario = scenario;
  if (requestScenario === "held") {
    await new Promise((resolve) => { releaseBooking = resolve; });
  }

  // The slow scenario exceeds Daisy's seven-second timeout.
  if (requestScenario === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }

  if (requestScenario === "conflict") {
    sendJson(response, 409, { error: "Not enough seats" });
    return;
  }

  if (requestScenario === "error") {
    response.writeHead(500);
    response.end();
    return;
  }

  sendJson(response, 201, {
    booking_id: `art_bk_mock_${String(bookingNumber).padStart(3, "0")}`,
    status: "confirmed",
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(
    `Mock Artisia is running on port ${port} with scenario: ${scenario}`,
  );
});