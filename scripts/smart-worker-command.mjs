export function workerCommand(target, dependencies) {
  if (!/^[a-f0-9]{40}$/.test(target)) throw new Error('Full target SHA required for VPS command.');
  return [
    'set -eu', 'cd /opt/gestao-marketplace',
    'test -z "$(git status --porcelain)"',
    'test "$(git branch --show-current)" = main',
    'git fetch --no-tags origin main',
    `test "$(git rev-parse origin/main)" = ${target}`,
    `git merge-base --is-ancestor HEAD ${target}`,
    // Only advance the existing branch; never create a merge commit or discard dirty files.
    `git reset --keep ${target}`,
    `test "$(git rev-parse HEAD)" = ${target}`,
    ...(dependencies ? ['npm ci'] : []),
    'pm2 restart marketplace-worker --update-env',
    "pm2 jlist | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d);process.stdin.on(\"end\",()=>{const p=JSON.parse(s).filter(p=>p.name===\"marketplace-worker\");process.exit(p.length>0&&p.every(p=>p.pm2_env.status===\"online\")?0:1)})'",
    `test "$(git rev-parse HEAD)" = ${target}`,
    `printf 'SMART_WORKER_SHA=${target}\\n'`
  ].join(' && ');
}
