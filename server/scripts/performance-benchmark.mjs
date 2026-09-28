import { performance } from "node:perf_hooks";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const elapsed = (started) => Math.round(performance.now() - started);

async function measured(operation) {
  const started = performance.now();
  await operation();
  return elapsed(started);
}

async function benchmark() {
  // Controlled I/O delays make the round-trip difference repeatable. This is
  // an orchestration benchmark, not a claim about a particular deployment.
  const io = { auth: 8, db: 12, verify: 45, balance: 35, provider: 80, write: 12 };

  const baselineInterview = await measured(async () => {
    await delay(io.auth);
    for (let index = 0; index < 8; index += 1) await delay(io.db); // full snapshot
    await delay(io.db); // credential row
    await delay(io.verify); // /models
    await delay(io.write); // status update
    await delay(io.balance);
    await delay(io.provider);
    for (let index = 0; index < 7; index += 1) await delay(io.write);
    await delay(io.db * 2); // project + usage reload
  });

  let authMs = 0;
  let stateMs = 0;
  let credentialMs = 0;
  let providerMs = 0;
  let persistenceMs = 0;
  const optimizedInterview = await measured(async () => {
    authMs = await measured(() => delay(io.auth));
    const stateStarted = performance.now();
    await delay(io.db); // ownership
    await Promise.all([delay(io.db), delay(io.db)]); // memory + session
    stateMs = elapsed(stateStarted);
    credentialMs = await measured(() => delay(io.db)); // row + local decrypt
    providerMs = await measured(() => delay(io.provider));
    persistenceMs = await measured(() => Promise.all(Array.from({ length: 7 }, () => delay(io.write))).then(() => undefined));
  });

  const baselineProjectList = await measured(async () => {
    await Promise.all([delay(io.db * 2), (async () => { await delay(io.db); await delay(io.verify); await delay(io.write); await delay(io.balance); })()]);
  });
  const optimizedProjectList = await measured(() => delay(io.db * 2));
  const secondaryStatus = await measured(async () => { await delay(io.db); await delay(io.verify); await Promise.all([delay(io.write), delay(io.balance)]); });

  const baselineCreate = await measured(async () => {
    await delay(io.auth + io.db + io.verify + io.write + io.balance + io.provider);
    for (let index = 0; index < 8; index += 1) await delay(io.write);
  });
  const optimizedCreate = await measured(async () => {
    await delay(io.auth + io.db + io.provider);
    await delay(io.write); // project FK root
    await Promise.all(Array.from({ length: 5 }, () => delay(io.write)));
    await delay(io.write); // message after session
  });

  console.log(JSON.stringify({
    benchmark: "controlled-round-trip-model",
    note: "Synthetic I/O benchmark; use [perf] production logs for deployment timings.",
    beforeMs: { projectListRender: baselineProjectList, projectCreate: baselineCreate, interviewTurn: baselineInterview },
    afterMs: { projectListRender: optimizedProjectList, orbioStatusSecondary: secondaryStatus, projectCreate: optimizedCreate, interviewTurn: optimizedInterview },
    optimizedInterviewStagesMs: { auth: authMs, projectState: stateMs, credential: credentialMs, provider: providerMs, persistence: persistenceMs, promgentOverhead: optimizedInterview - providerMs },
  }, null, 2));
}

await benchmark();
