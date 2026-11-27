import { Queue } from "bullmq";
const q = new Queue("production", { connection: { host: "127.0.0.1", port: 6379 } });
let prev = "";
for (;;) {
  try {
    const c = await q.getJobCounts("active","waiting","waiting-children","failed","completed");
    const act = (await q.getJobs(["active"])).map(j => `${j.name}:${j.id.slice(0,4)}@${j.processedOn ? new Date(j.processedOn).toISOString().slice(11,19) : "-"}`).join(",");
    const s = JSON.stringify(c) + " active=[" + act + "]";
    if (s !== prev) { console.log(new Date().toISOString().slice(11,19), s); prev = s; }
    if (c["waiting-children"] === 0 && c.active === 0 && c.waiting === 0) { console.log("queue idle"); break; }
  } catch (e) { console.log("err", e.message); }
  await new Promise(r => setTimeout(r, 10000));
}
await q.close(); process.exit(0);
