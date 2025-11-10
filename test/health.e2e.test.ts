// test/health.e2e.test.ts
import Fastify from "fastify";
import * as crpHealth from "../src/routes/crp.health";

// Support default export, named `routes`, or module-as-plugin
const healthPlugin =
  (crpHealth as any).default ?? (crpHealth as any).routes ?? (crpHealth as any);

describe("CRP health route", () => {
  const app = Fastify();

  beforeAll(async () => {
    app.register(healthPlugin);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /v1/crp/health returns 200 and ok:true", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/crp/health" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body?.ok).toBe(true);
    expect(body?.service).toBe("CRP");
    expect(typeof body?.grpc?.host).toBe("string");
  });
});
