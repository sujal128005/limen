// Minimal Node.js (18+) client: how the existing Node service calls the engine.
//   node examples/node_client.mjs http://127.0.0.1:8088
const base = process.argv[2] ?? "http://127.0.0.1:8088";

async function limen(path, body) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${payload.error.code}: ${payload.error.message}`);
  return payload;
}

const parsed = await limen("/v1/buyer/requirements/parse", {
  actor: { role: "BUYER_SALES", org_id: "BUY-001", user_id: "u-sales" },
  requirement_id: "REQ-1",
  buyer_org_id: "BUY-001",
  text: "Need 25 MT HR coil IS 2062 E250, 3 mm thick, width 1250 mm. Deliver to Pune in 14 days.",
});
console.log("rfq_ready:", parsed.rfq_ready, "| material:", parsed.requirement.material,
            "| quantity:", parsed.requirement.quantity, parsed.requirement.uom);
