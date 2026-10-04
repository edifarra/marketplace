// Side effects are injected so every ordering and failure can be tested offline.
export async function executeDeployment(plan, io) {
  if (plan.mode !== 'execute') return;
  const { classification: c, target, base } = plan;
  if (!c.frontend && !c.worker && !c.migration) return;
  await io.preflight();
  await io.validate();
  if (await io.confirm() !== 'DEPLOY') throw new Error('Deployment cancelled: DEPLOY is required.');
  await io.revalidate();
  const progress = await io.loadProgress();
  let journal = progress ?? { target, base };
  if (progress && (progress.target !== target || progress.base !== base)) {
    if (plan.supersedeFrontend !== progress.target || progress.base !== base || !c.frontend || c.migration || c.worker || progress.migration || !await io.canSupersede(progress))
      throw new Error('Unfinished deployment belongs to another target/baseline. Reconcile it first.');
    journal = { target, base, superseded: progress };
    await io.saveProgress(journal);
  }
  if (c.migration) {
    if (await io.isPublished() && !journal.migration) throw new Error('Migration SHA already published without controlled migration confirmation. Reconcile first.');
    const applied = await io.confirmMigrations();
    if (!applied) {
      if (await io.isPublished()) throw new Error('Pending migrations for an already published SHA; unsafe recovery.');
      await io.migrate();
      if (!await io.confirmMigrations()) throw new Error('Migration confirmation failed; push blocked.');
    }
    journal.migration = true;
    await io.saveProgress(journal);
  }
  await io.revalidate();
  if (!await io.isPublished()) await io.push();
  await io.verifyPublished();
  journal.pushed = true;
  await io.saveProgress(journal);
  // Recheck deployment on resume; a journal entry is not proof of live success.
  if (c.frontend) journal.vercel = await io.waitVercel();
  await io.revalidate();
  await io.verifyPublished();
  if (c.worker) await io.updateWorker();
  await io.revalidate();
  await io.verifyPublished();
  await io.complete({ commit: target, deployedAt: new Date().toISOString(), deployment: journal.vercel ?? null });
  await io.clearProgress();
}
