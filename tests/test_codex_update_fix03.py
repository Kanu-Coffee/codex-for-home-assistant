"""Regression checks for interrupted runtime handovers and work tracking."""

import json
import os
import subprocess
import time
from pathlib import Path
import pytest


@pytest.fixture(autouse=True)
def private_package_umask():
    previous = os.umask(0o022)
    try:
        yield
    finally:
        os.umask(previous)


def node_json(repository_root: Path, script: str, timeout: int = 20) -> dict:
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=repository_root,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=True,
    )
    return json.loads(result.stdout.splitlines()[-1])


def test_rollback_preserves_barrier_if_new_worker_will_not_drain(repository_root: Path, tmp_path: Path) -> None:
    worker = """import readline from 'node:readline';
process.on('SIGHUP', () => { if (!process.argv.includes('ignore')) process.exit(0); });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const error = msg.method === 'thread/resume' && process.argv.includes('ignore');
  const result = msg.method === 'thread/read' ? {thread:{id:msg.params.threadId,ephemeral:false,path:process.env.CODEX_HOME+'/sessions/rollout.jsonl'}} : {};
  console.log(JSON.stringify(error ? {id:msg.id,error:{message:'resume failed'}} : {id:msg.id,result}));
});
setInterval(() => {}, 1000);
"""
    script_path = tmp_path / "worker.mjs"
    script_path.write_text(worker)
    (tmp_path / "sessions").mkdir()
    (tmp_path / "sessions" / "rollout.jsonl").write_text("synthetic\n")
    script = f"""
import {{StdioRelay}} from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs';
const relay = new StdioRelay({{childExe:process.execPath,childArgs:[{json.dumps(str(script_path))}],childEnv:{{...process.env,CODEX_HOME:{json.dumps(str(tmp_path))}}}}});
const children = [];
const spawn = relay._spawnChild.bind(relay);
relay._spawnChild = async (...args) => {{const child = await spawn(...args);children.push(child);return child;}};
try {{
  await relay.start({{attachStdio:false}});
  relay.loadedThreadIds.add('synthetic-thread');
  const result = await relay.switchWorker({{exe:process.execPath,version:'0.163.0',args:[{json.dumps(str(script_path))},'ignore']}});
  const release = await relay._handleControlCommand({{cmd:'barrier',enabled:false}});
  const live = children.filter(c => {{try {{process.kill(c.pid,0);return true;}} catch {{return false;}}}}).length;
  console.log(JSON.stringify({{result,release,live,barrier:relay.barrier}}));
}} finally {{ for (const child of children) {{try {{child.kill('SIGTERM');}} catch {{}}}} relay._cleanup(); }}
"""
    result = node_json(repository_root, script)
    assert result["result"]["rollbackStatus"] == "rollback_incomplete"
    assert result["live"] == 1
    assert result["barrier"] is True
    assert result["release"]["success"] is False


def test_repeated_thread_status_and_metadata_do_not_create_false_work(repository_root: Path) -> None:
    script = """
import {StdioRelay} from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs';
import {readFileSync} from 'node:fs';
const relay = new StdioRelay({childExe:'/synthetic/worker'});
relay.child = {pid:process.pid,exitCode:null,stdin:{writable:true,write:()=>{}}};
const stat=readFileSync('/proc/self/stat','utf8');
relay.childStartTime=stat.slice(stat.lastIndexOf(')')+1).trim().split(/\\s+/)[19];
const event = (method,params) => relay._handleServerData(Buffer.from(JSON.stringify({method,params})+'\\n'));
event('turn/started',{threadId:'t',turn:{id:'turn'}});
event('thread/status/changed',{threadId:'t',status:{type:'active',activeFlags:[]}});
event('thread/status/changed',{threadId:'t',status:{type:'active',activeFlags:['waitingOnApproval']}});
event('turn/completed',{threadId:'t',turn:{id:'turn'}});
event('thread/status/changed',{threadId:'t',status:{type:'idle'}});
relay._handleClientData(Buffer.from(JSON.stringify({id:1,method:'thread/read',params:{threadId:'history'}})+'\\n'));
relay._handleServerData(Buffer.from(JSON.stringify({id:1,result:{thread:{id:'history',status:{type:'notLoaded'}}}})+'\\n'));
const idle = await relay._handleControlCommand({cmd:'inspect'});
event('thread/status/changed',{threadId:'t',status:{type:'unexpected'}});
const unknown = await relay._handleControlCommand({cmd:'inspect'});
console.log(JSON.stringify({idle,unknown}));
"""
    result = node_json(repository_root, script)
    assert result["idle"]["busy"] is False
    assert result["idle"]["activeTurns"] == 0
    assert "history" not in result["idle"]["loadedThreads"]
    assert result["unknown"]["busy"] is True
    assert result["unknown"]["unknown"] is True


def test_unpersisted_thread_defers_before_stopping_worker(repository_root: Path, tmp_path: Path) -> None:
    (tmp_path / "sessions").mkdir()
    worker = tmp_path / "worker.mjs"
    worker.write_text("""import readline from 'node:readline';
process.on('SIGHUP',()=>process.exit(0));
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.id===undefined)return;
  const result=m.method==='thread/read' ? {thread:{id:m.params.threadId,ephemeral:false,path:process.env.CODEX_HOME+'/sessions/not-written.jsonl'}} : {};
  console.log(JSON.stringify({id:m.id,result}));
});
""")
    worker2 = tmp_path / "worker2.mjs"
    worker2.write_text("""import readline from 'node:readline';
process.on('SIGHUP',()=>process.exit(0));
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);if(m.id===undefined)return;
  const result=m.method==='thread/start'?{thread:{id:'replacement'}}:{};
  console.log(JSON.stringify({id:m.id,result}));
});
""")
    script = f"""
import {{StdioRelay}} from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs';
const relay=new StdioRelay({{childExe:process.execPath,childArgs:[{json.dumps(str(worker))}],childEnv:{{...process.env,CODEX_HOME:{json.dumps(str(tmp_path))}}}}});
try {{
  await relay.start({{attachStdio:false}});const pid=relay.child.pid;relay.loadedThreadIds.add('new-thread');relay.emptyThreadParams.set('new-thread', {{}});
  const result=await relay.switchWorker({{exe:process.execPath,args:[{json.dumps(str(worker2))}],version:'0.163.0'}});
  relay._handleClientData(Buffer.from(JSON.stringify({{id:7,method:'model/list'}})+'\\n'));
  await new Promise(resolve=>setTimeout(resolve,100));
  console.log(JSON.stringify({{result,sameWorker:relay.child.pid===pid,barrier:relay.barrier,requestCompleted:!relay.inFlightClientRequests.has(7)}}));
}} finally {{relay._cleanup();}}
"""
    result = node_json(repository_root, script)
    assert result["result"]["success"] is True
    assert result["sameWorker"] is False
    assert result["barrier"] is False
    assert result["requestCompleted"] is True


def test_worker_exit_during_preflight_keeps_barrier(repository_root: Path, tmp_path: Path) -> None:
    worker = tmp_path / "worker.mjs"
    worker.write_text("""import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line); if(m.method==='thread/read') process.exit(0);
});
""")
    script = f"""
import {{StdioRelay}} from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs';
const relay=new StdioRelay({{childExe:process.execPath,childArgs:[{json.dumps(str(worker))}]}});
try {{
  await relay.start({{attachStdio:false}});relay.loadedThreadIds.add('t');
  const send=relay._sendInternalRpc.bind(relay);
  relay._sendInternalRpc=(method,params)=>send(method,params,200);
  const result=await relay.switchWorker({{exe:'/not-started',version:'0.163.0'}});
  const release=await relay._handleControlCommand({{cmd:'barrier',enabled:false}});
  console.log(JSON.stringify({{result,release,barrier:relay.barrier}}));
}} finally {{relay._cleanup();}}
"""
    result = node_json(repository_root, script)
    assert result["result"]["rollbackStatus"] == "rollback_incomplete"
    assert result["barrier"] is True
    assert result["release"]["success"] is False


def test_failed_barrier_release_is_not_reported_as_applied(repository_root: Path, tmp_path: Path) -> None:
    script = f"""
import {{restartServers}} from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-server-transaction.mjs';
import {{createServer}} from 'node:net';
import {{chmodSync}} from 'node:fs';
const path={json.dumps(str(tmp_path / 'control.sock'))};let barrier=false, selected='old';const phases=[];
const server=createServer(c=>{{let buf='';c.on('data',data=>{{buf+=data;const lines=buf.split('\\n');buf=lines.pop();
for(const line of lines){{const req=JSON.parse(line);let res;
if(req.cmd==='barrier'){{if(req.enabled){{barrier=true;res={{success:true,barrier:true}};}}else res={{error:'release failed'}};}}
else if(req.cmd==='inspect')res={{busy:false,inFlight:0,pending:0,activeTurns:0,loadedThreads:[],workerPid:process.pid,relayPid:process.pid,version:server.version||'0.162.1'}};
else if(req.cmd==='switch_worker'){{res={{success:true,workerPid:process.pid,version:req.version}};server.version=req.version;}}
c.write(JSON.stringify(res)+'\\n');}}}});}});
await new Promise(r=>server.listen(path,r));chmodSync(path,0o600);
try {{
  const result=await restartServers({{servers:[{{type:'remote-stdio',pid:process.pid,controlSocket:path,managedRecord:{{exe:'/old',version:'0.162.1',args:[],cwd:'/'}}}}],
    binary:'/new',version:'0.163.0',inspectProcess:async()=>null,inspectServer:async()=>({{busy:false}}),
    switchToNew:async()=>{{selected='new';}},switchToOld:async()=>{{selected='old';}},writeRecord:async()=>{{}},removeRecord:async()=>{{}},commitAttempt:async()=>{{}},
    writeJournal:async entry=>phases.push(entry.phase),clearJournal:async()=>phases.push('cleared'),verifyHost:async()=>true}});
  console.log(JSON.stringify({{result,barrier,selected,phases}}));
}} finally {{await new Promise(r=>server.close(r));}}
"""
    result = node_json(repository_root, script)
    assert result["result"]["applied"] is False
    assert result["result"]["recovery"] == "rollback_incomplete"
    assert result["barrier"] is True
    assert result["selected"] == "new"
    assert result["phases"][-1] == "release_incomplete"
    assert "cleared" not in result["phases"]


def test_interrupted_transaction_blocks_restart_and_new_update(repository_root: Path, tmp_path: Path) -> None:
    runtime = tmp_path / "runtime"
    maintenance = tmp_path / "maintenance"
    runtime.mkdir()
    (runtime / "transaction.json").write_text('{"schemaVersion":1,"phase":"switching_worker"}')
    script = f"""
process.env.CODEX_RUNTIME_DIR={json.dumps(str(runtime))};
process.env.CODEX_MAINTENANCE_DIR={json.dumps(str(maintenance))};
process.env.CODEX_BASELINE_DIR={json.dumps(str(tmp_path / 'missing-baseline'))};
const mgr=await import('./codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs');
const state=await mgr.initRuntime();
const check=await mgr.checkUpdate();
const apply=await mgr.applyUpdate({{isManual:true}});
const status=await mgr.getStatus();
console.log(JSON.stringify({{state,check,apply,status}}));
"""
    result = node_json(repository_root, script)
    assert result["state"]["blockedReason"] == "blocked_restart"
    assert result["check"]["blocked"] is True
    assert result["apply"]["reason"] == "rollback_incomplete"
    assert result["status"]["pendingRecovery"] is True
    assert result["status"]["autoApplyReady"] is False
    assert (runtime / "transaction.json").exists()


def test_actual_relay_worker_identity_and_stale_record(repository_root: Path, tmp_path: Path) -> None:
    runtime = tmp_path / "runtime"
    maintenance = tmp_path / "maintenance"
    (maintenance / "sessions").mkdir(parents=True)
    (maintenance / "control").mkdir()
    worker = runtime / "releases" / "0.162.1-test" / "bin" / "codex"
    worker.parent.mkdir(parents=True)
    worker.write_text("#!/usr/bin/env node\nprocess.on('SIGHUP',()=>process.exit(0));setInterval(()=>{},1000);\n")
    worker.chmod(0o755)
    host = repository_root / "codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs"
    env = {**os.environ, "CODEX_RUNTIME_DIR": str(runtime), "CODEX_MAINTENANCE_DIR": str(maintenance)}
    relay = subprocess.Popen(
        ["bash", "-c", 'exec node "$1" --control-socket "$2/control/stdio-$$.sock" '
         '--session-file "$2/sessions/$$" --exe "$3" -- app-server', "fixture", str(host), str(maintenance), str(worker)],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=env,
    )
    try:
        record = maintenance / "sessions" / str(relay.pid)
        for _ in range(100):
            if record.exists():
                break
            time.sleep(0.05)
        assert record.exists()
        script = f"""
process.env.CODEX_RUNTIME_DIR={json.dumps(str(runtime))};
process.env.CODEX_MAINTENANCE_DIR={json.dumps(str(maintenance))};
const mgr=await import('./codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs');
console.log(JSON.stringify(await mgr.inspectAllSessions({{readOnly:true}})));
"""
        before = node_json(repository_root, script)
        assert before["canApply"] is True, before["busyReasons"]
        candidate = runtime / "releases" / "0.163.0-test"
        (candidate / "bin").mkdir(parents=True)
        candidate.chmod(0o755)
        (candidate / "bin").chmod(0o755)
        (candidate / "bin" / "codex").write_text("#!/bin/sh\necho codex-cli 0.163.0\n")
        (candidate / "bin" / "codex").chmod(0o755)
        (candidate / "codex-package.json").write_text(json.dumps({
            "version": "0.163.0", "target": "x86_64-unknown-linux-musl", "entrypoint": "bin/codex",
        }))
        (runtime / "staged").symlink_to(candidate)
        apply_script = f"""
process.env.CODEX_RUNTIME_DIR={json.dumps(str(runtime))};
process.env.CODEX_MAINTENANCE_DIR={json.dumps(str(maintenance))};
const mgr=await import('./codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs');
const ledger=await import('./codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-package-integrity.mjs');
const candidate={json.dumps(str(candidate))}, digest='b'.repeat(64);
await ledger.recordPackage(candidate,mgr.getBaseRuntimeDir(),digest,await ledger.packageInventory(candidate));
await mgr.updateState(s=>{{s.stagedVersion='0.163.0';s.candidateVersion='0.163.0';s.candidateDigest=digest;}});
console.log(JSON.stringify(await mgr.applyUpdate({{isManual:true,verifiedLiveRestart:true}})));
"""
        update = node_json(repository_root, apply_script)
        assert update["applied"] is False
        assert update["reason"] in ("compatibility_unverified", "blocked_policy")
        assert relay.poll() is None
        data = json.loads(record.read_text())
        data["workerStart"] = "1"
        record.write_text(json.dumps(data))
        after = node_json(repository_root, script)
        assert after["canApply"] is False
        assert "identity unverified" in " ".join(after["busyReasons"])
    finally:
        relay.terminate()
        relay.communicate(timeout=5)


def test_ephemeral_thread_is_recreated_and_next_turn_reaches_new_worker(repository_root: Path, tmp_path: Path) -> None:
    worker = tmp_path / 'ephemeral-worker.mjs'
    worker.write_text('''import readline from "node:readline";
process.on("SIGHUP",()=>process.exit(0));
readline.createInterface({input:process.stdin}).on("line",line=>{
 const m=JSON.parse(line);if(m.id===undefined)return;
 let result={};
 if(m.method==="thread/read")result={thread:{id:m.params.threadId,ephemeral:true,path:null,turns:[]}};
 if(m.method==="thread/start")result={thread:{id:"replacement",status:{type:"idle"}}};
 if(m.method==="turn/start")result=m.params.threadId==="replacement"?{turn:{id:"turn",status:"completed"}}:{error:"wrong-thread"};
 console.log(JSON.stringify({id:m.id,result}));
});
''')
    script = f"""
import {{StdioRelay}} from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs';
const relay=new StdioRelay({{childExe:process.execPath,childArgs:[{json.dumps(str(worker))}]}});
try {{
 await relay.start({{attachStdio:false}});relay.loadedThreadIds.add('original');relay.emptyThreadParams.set('original', {{ephemeral:true}});
 const switched=await relay.switchWorker({{exe:process.execPath,args:[{json.dumps(str(worker))}],version:'0.164.0'}});
 relay._handleClientData(Buffer.from(JSON.stringify({{id:7,method:'turn/start',params:{{threadId:'original',input:[]}}}})+'\\n'));
 await new Promise(resolve=>setTimeout(resolve,150));
 console.log(JSON.stringify({{switched,mapped:relay.clientToServerThreadMap.get('original'),pending:relay.pendingTurnStarts.has(7)}}));
}} finally {{relay._cleanup();}}
"""
    result = node_json(repository_root, script)
    assert result['switched']['success'] is True
    assert result['mapped'] == 'replacement'
    assert result['pending'] is False


def test_completed_managed_title_unsubscribe_retires_only_title(repository_root: Path) -> None:
    script = """
import {StdioRelay} from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs';
const r=new StdioRelay({childExe:process.execPath,sessionType:'cli',spawnClient:true});
r.clientProc={pid:123};r.child={stdin:{writable:true,write:()=>{}}};
const client=(x)=>r._handleClientData(Buffer.from(JSON.stringify(x)+'\\n'));
const server=(x)=>r._handleServerData(Buffer.from(JSON.stringify(x)+'\\n'));
client({id:1,method:'thread/start',params:{ephemeral:true,threadSource:'thread_title'}});
server({id:1,result:{thread:{id:'title',status:{type:'idle'}}}});
client({id:2,method:'thread/start',params:{ephemeral:true,threadSource:'user'}});
server({id:2,result:{thread:{id:'user',status:{type:'idle'}}}});
server({method:'turn/started',params:{threadId:'title',turn:{id:'active-title'}}});
client({id:3,method:'thread/unsubscribe',params:{threadId:'title'}});
server({id:3,result:{status:'unsubscribed'}});
const activePreserved=r.loadedThreadIds.has('title');
server({method:'turn/completed',params:{threadId:'title',turn:{id:'active-title'}}});
client({id:5,method:'thread/unsubscribe',params:{threadId:'title'}});
server({id:5,result:{status:'unsubscribed'}});
client({id:4,method:'thread/unsubscribe',params:{threadId:'user'}});
server({id:4,result:{status:'unsubscribed'}});
console.log(JSON.stringify({activePreserved,title:r.loadedThreadIds.has('title'),user:r.loadedThreadIds.has('user')}));
"""
    result = node_json(repository_root, script)
    assert result['activePreserved'] is True
    assert result['title'] is False
    assert result['user'] is True


@pytest.mark.parametrize('blocked', [None, 'capabilities', 'pending'])
def test_owned_tui_reconnect_reuses_only_compatible_drained_handshake(repository_root: Path, blocked: str | None) -> None:
    result = node_json(repository_root, """
import {StdioRelay} from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs';
const relay = new StdioRelay({childExe:'/synthetic/worker',spawnClient:true});
const writes=[], replies=[];
relay.child = {stdin:{writable:true,write:data=>{writes.push(JSON.parse(data));return true;}}};
relay.clientSocketPath='/synthetic/socket';
relay._wsSendText = text=>{replies.push(JSON.parse(text));return true;};
const request = obj=>relay._processAndForwardClientChunk(JSON.stringify(obj)+'\\n');
request({id:1,method:'initialize',params:{clientInfo:{name:'tui',version:'1'},capabilities:{experimentalApi:true}}});
relay._handleServerData(JSON.stringify({id:1,result:{userAgent:'synthetic'}})+'\\n');
request({method:'initialized'});
relay.replacementHandshake=true;
const blocked=""" + json.dumps(blocked) + """;
if(blocked==='pending') relay.inFlightClientRequests.set(9,{method:'thread/list'});
request({id:2,method:'initialize',params:{clientInfo:{name:'tui',version:'1'},capabilities:{experimentalApi:blocked!=='capabilities'}}});
request({method:'initialized'});
if(blocked) request({id:3,method:'thread/list',params:{}});
console.log(JSON.stringify({writes,replies,handshake:relay.replacementHandshake}));
""")
    assert [msg.get('method') for msg in result['writes']] == ['initialize', 'initialized']
    reply = next(msg for msg in result['replies'] if msg.get('id') == 2)
    if blocked:
        assert reply['error']['code'] == -32600
        assert result['replies'][-1]['id'] == 3
        assert result['replies'][-1]['error']['code'] == -32600
        assert result['handshake'] is True
    else:
        assert reply['result']['userAgent'] == 'synthetic'
        assert result['handshake'] is False
