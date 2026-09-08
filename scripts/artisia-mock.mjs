import { createServer } from "node:http";

const port = 4010;
const scenario = process.env.ARTISIA_MOCK_SCENARIO ?? "success";

const server = createServer(async (request, response) => {
  const isBookingRequest =
    request.method === "POST" &&
    /^\/v1\/sessions\/[^/]+\/bookings$/.test(request.url ?? "");

  if (!isBookingRequest) {
    response.writeHead(404);
    response.end();
    return;
  }

  if (request.headers.authorization !== "Bearer test-api-key") {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Invalid API key" }));
    return;
  }

  // The slow scenario exceeds Daisy's seven-second timeout.
  if (scenario === "slow") {
    await new Promise((resolve) => setTimeout(resolve, 8_000));
  }

  if (scenario === "conflict") {
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "Not enough seats" }));
    return;
  }

  if (scenario === "error") {
    response.writeHead(500);
    response.end();
    return;
  }

  response.writeHead(201, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      booking_id: "art_bk_mock_001",
      status: "confirmed",
    }),
  );
});

server.listen(port, "0.0.0.0", () => {
  console.log(`Mock Artisia is running on port ${port} with scenario: ${scenario}`);
});