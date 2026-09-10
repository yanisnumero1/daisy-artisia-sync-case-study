import { createServer } from "node:http";

const port = 4010;
const allowedScenarios = new Set(["success", "conflict", "error", "slow", "held", "slow_success_4", "slow_success_6", "rate_limit"]);

let scenario = process.env.ARTISIA_MOCK_SCENARIO ?? "success";
let bookingRequestCount = 0;
let releaseBooking;
let sessionRequestCount = 0;
const initialSessions = () => [{ session_id: "art_ses_8812", external_ref: "11111111-1111-1111-1111-111111111111",
  title: "Beginner pottery", starts_at: "2027-01-16T14:00:00+01:00", duration_minutes: 120,
  capacity: 8, booked: 0, status: "published", updated_at: new Date().toISOString() }];
let sessions = initialSessions();

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
      sessionRequestCount = 0;
      sessions = initialSessions();
      sendJson(response, 200, { scenario });
    } catch {
      sendJson(response, 400, { error: "Invalid JSON" });
    }

    return;
  }

  if (request.method === "PUT" && request.url === "/__sessions") {
    sessions = (await readJson(request)).sessions;
    sendJson(response, 200, { sessions });
    return;
  }
  if (request.method === "GET" && request.url === "/v1/sessions") {
    if (request.headers.authorization !== "Bearer test-api-key") return sendJson(response, 401, { error: "Invalid API key" });
    sessionRequestCount += 1;
    if (scenario === "error" || scenario === "rate_limit") {
      response.writeHead(scenario === "error" ? 500 : 429);
      response.end();
      return;
    }
    sendJson(response, 200, { sessions });
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
      sessionRequestCount,
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
  const requestSessions = sessions;
  const input = await readJson(request);
  if (requestScenario === "held") {
    await new Promise((resolve) => { releaseBooking = resolve; });
  }

  // The slow scenario exceeds Daisy's seven-second timeout.
  if (requestScenario === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }

  if (requestScenario.startsWith("slow_success_")) {
    await new Promise((resolve) => setTimeout(resolve, Number(requestScenario.at(-1)) * 1_000));
  }
  if (requestScenario === "rate_limit") {
    response.writeHead(429); response.end(); return;
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

  requestSessions[0].booked += input.seats;
  requestSessions[0].updated_at = new Date().toISOString();
  sendJson(response, 201, {
    booking_id: `art_bk_mock_${String(bookingNumber).padStart(3, "0")}`,
    status: "confirmed",
    seats: input.seats,
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(
    `Mock Artisia is running on port ${port} with scenario: ${scenario}`,
  );
});