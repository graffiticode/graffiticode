// The C5a gate's due-phase fixtures (scripts/c5a-gate.js --phase due and
// --phase cleanup): commands allocated as the gateway and never run, so that
// Policy's due query can be observed over them, then retired without running.
//
//   ensureFixtures({ client, state, save, specs }) -> { name: commandId }
//     Allocates each spec's command once. Each id is saved to the run's state
//     the moment it is known, so an interrupted setup resumes: a spec with a
//     saved id is never allocated again, and one without is allocated under
//     its deterministic key (Policy answers a key it already holds with the
//     same command).
//   retireFixtures({ client, ids, worker, now, sleep }) -> { commandId: status }
//     Ends each still-pending fixture without running it: it waits out any
//     live lease (never acting under another worker's), takes the command
//     over (a fenced lease: the next generation, declaring `scopes`, so a v3
//     fixture is takeable), and finishes it with no result. With nothing
//     bound, Policy records it `failed`, with no publication. Idempotent: a
//     finished fixture is left as it is, so an interrupted cleanup reruns.
//   verifyRetired({ client, ids }) -> { statuses, listedAfter }
//     Each fixture's status, and any fixture still listed by the due query
//     asked as production asks it or as a `scopes` worker does.
//
// `client` is Policy's gateway command routes:
//   allocate(body) -> summary   get(commandId) -> summary
//   lease(commandId, body) -> summary   finish(commandId, generation) -> summary
//   due({ scopes }) -> { commands: [{ commandId }] }
// Each throws on a refusal, with `reason` when Policy gave one.

export const ensureFixtures = async ({ client, state, save, specs }) => {
  state.fixtures ??= {};
  for (const spec of specs) {
    if (state.fixtures[spec.name]) continue;
    const out = await client.allocate(spec.body);
    if (!out?.commandId) throw new Error(`fixture ${spec.name}: no command id`);
    state.fixtures[spec.name] = out.commandId;
    await save();
  }
  return { ...state.fixtures };
};

const RETRIES = 4;
export const retireFixtures = async ({ client, ids, worker, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) => {
  const statuses = {};
  for (const id of ids) {
    for (let attempt = 0; ; attempt++) {
      const command = await client.get(id);
      if (command.status !== "pending") {
        statuses[id] = command.status;
        break;
      }
      if (attempt >= RETRIES) throw new Error(`fixture ${id}: still pending after ${RETRIES} attempts`);
      // Never under another worker's live lease: wait it out.
      const wait = command.leaseExpiresAt - now();
      if (wait > 0) {
        await sleep(wait + 1_000);
        continue;
      }
      try {
        const taken = await client.lease(id, { worker, generation: command.generation, takeOver: true, recording: 1, repairs: 1, scopes: 1 });
        const done = await client.finish(id, taken.generation);
        statuses[id] = done.status;
        break;
      } catch (e) {
        // Another worker took it or finished it first: read it again.
        if (!e?.reason) throw e;
      }
    }
  }
  return statuses;
};

export const verifyRetired = async ({ client, ids }) => {
  const statuses = {};
  for (const id of ids) statuses[id] = (await client.get(id)).status;
  const listed = new Set();
  for (const scopes of [false, true]) {
    for (const c of (await client.due({ scopes })).commands ?? []) listed.add(c.commandId);
  }
  return { fixtures: [...ids], statuses, listedAfter: ids.filter(id => listed.has(id)) };
};
