export function workerCommand(target, dependencies) {
  if (!/^[a-f0-9]{40}$/.test(target)) throw new Error('Full target SHA required for VPS command.');
  const commands = [
    'cd /opt/gestao-marketplace',
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
  ];
  const stages = ['workspace', 'clean-checkout', 'main-branch', 'fetch', 'origin-sha', 'ancestor', 'checkout', 'checkout-sha',
    ...(dependencies ? ['dependencies'] : []), 'pm2-restart', 'pm2-online', 'final-sha', 'confirmation'];
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  return 'set -eu; printf "SMART_WORKER_CONNECTED\\n"; ' +
    'smart_step() { printf "SMART_WORKER_START=%s\\n" "$1"; if eval "$2"; then printf "SMART_WORKER_DONE=%s\\n" "$1"; else smart_rc=$?; printf "SMART_WORKER_FAILED=%s:%s\\n" "$1" "$smart_rc" >&2; return "$smart_rc"; fi; }; ' +
    commands.map((command, i) => `smart_step ${quote(stages[i])} ${quote(command)}`).join(' && ');
}
