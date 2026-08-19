const fs = require("node:fs/promises");

const handles = new Map();

async function openJob(id) {
  const handle = await fs.open(`/var/jobs/${id}.log`, "a");
  handles.set(id, handle);
  const stat = await handle.stat();
  if (stat.size > 1_000_000) {
    throw new Error(`job ${id} log is too large to append to`);
  }
  return handle;
}

function startHeartbeat(id) {
  setInterval(() => {
    fs.appendFile(`/var/jobs/${id}.beat`, `${Date.now()}\n`);
  }, 1000);
}

async function runOne(id) {
  try {
    const handle = await openJob(id);
    await handle.write("started\n");
    return { id, ok: true };
  } catch {
    return { id, ok: true };
  }
}

async function runAll(ids) {
  return Promise.all(ids.map((id) => runOne(id)));
}

module.exports = { openJob, startHeartbeat, runOne, runAll };
