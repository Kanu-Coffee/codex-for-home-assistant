#!/usr/bin/env bash
set -Eeuo pipefail
IMAGE=${1:-codex-for-home-assistant:test}
PROFILE=${CODEX_TEST_APPARMOR:-codex_home_assistant}
TEST_ID="codex-ha-updater-${RANDOM}-$$"
cleanup() {
  docker rm -f "$TEST_ID" >/dev/null 2>&1 || true
  docker volume rm "${TEST_ID}-config" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Synthetic protected targets only; never mount the host's HA configuration.
docker volume create "${TEST_ID}-config" >/dev/null
docker run --rm --security-opt apparmor=unconfined -v "${TEST_ID}-config:/config" \
  --entrypoint /bin/bash "$IMAGE" -c 'mkdir -p /config/.storage; printf fixture > /config/secrets.yaml'
docker run -d --name "$TEST_ID" --security-opt seccomp=unconfined \
  --security-opt "apparmor=$PROFILE" -v "${TEST_ID}-config:/config" \
  --entrypoint /bin/sleep "$IMAGE" infinity >/dev/null
docker exec "$TEST_ID" /bin/bash -c '
  mkdir -p /data/home /data/codex /data/codex-ha-memory
  printf "{\"codex_auto_update\":true}" > /data/options.json
  tar -czf /tmp/package-fixture.tar.gz -C /usr/local/lib/codex-ha/codex-baseline .
'
# Repack the real, pinned baseline bytes as a local candidate fixture. This
# exercises policy/resource/application paths, not a newer upstream release.
docker exec -i "$TEST_ID" node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import * as mgr from '/usr/local/share/codex-ha/codex-runtime-manager.mjs';
import {verifyManagedPolicy} from '/usr/local/share/codex-ha/codex-policy-probe.mjs';
import {readFile, readdir, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
await mgr.initRuntime();
const version=mgr.getBundledVersion();
const digest=createHash('sha256').update(await readFile('/tmp/package-fixture.tar.gz')).digest('hex');
const release={version,expectedSha256:digest};
const staged=await mgr.downloadAndStagePackage(release, 'file:///tmp/package-fixture.tar.gz');
await mgr.updateState(s=>{s.candidateVersion=version;s.candidateDigest=digest;s.stagedVersion=version;s.status='ready_to_apply';});
assert.equal((await verifyManagedPolicy(staged.path)).valid, true, 'candidate real managed policy');
const applied=await mgr.applyUpdate({isManual:true});
assert.equal(applied.applied,true,JSON.stringify(applied));
// Quotes and backslashes must survive the actual wrapper's JSON encoder.
const socket='/tmp/updater-"quote-\\slash.sock';
const child=spawn('/usr/local/bin/codex',['app-server','--listen','unix://'+socket],{cwd:'/config',stdio:'ignore'});
child.on('error',()=>{});
try {
  for(let i=0;i<100;i++) {try {if((await stat(socket)).isSocket())break;}catch{} await wait(50);}
  const record=JSON.parse(await readFile(mgr.getSessionsDir()+'/'+child.pid,'utf8'));
  assert.equal(record.socketPath,socket);
  assert.equal(record.exe,staged.path+'/bin/codex');
  assert.equal(record.version,version);
  assert.equal(record.cwd,'/config');
  assert(record.args.includes('unix://'+socket));
  const inspection=await mgr.inspectAppServer(socket, child.pid, version);
  assert.equal(inspection.busy,false,JSON.stringify(inspection));
  // Restage and use the actual wrapper record for an actual Codex restart.
  await mgr.downloadAndStagePackage(release,'file:///tmp/package-fixture.tar.gz');
  await mgr.updateState(s=>{s.candidateVersion=version;s.candidateDigest=digest;s.stagedVersion=version;s.status='ready_to_apply';});
  const restarted=await mgr.applyUpdate({isManual:true});
  assert.equal(restarted.applied,true,JSON.stringify(restarted));
  const live=(await mgr.inspectAllSessions()).restartableServers;
  assert.equal(live.length,1);
  assert.notEqual(live[0].pid,child.pid);
  assert.equal(live[0].managedRecord.exe,record.exe);
  assert.equal(live[0].managedRecord.version,version);
  console.log('Codex updater smoke passed: real policy, resources, wrapper JSON, actual executable, graceful restart');
} finally {
  try{child.kill('SIGHUP');}catch{}
  for(const file of await readdir(mgr.getSessionsDir())) {
    try {const record=JSON.parse(await readFile(mgr.getSessionsDir()+'/'+file,'utf8'));if(record.type==='app-server')process.kill(record.pid,'SIGHUP');}catch{}
  }
}
JS
