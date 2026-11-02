// Integration fixture for the built image: actual wrapper, manager, workers and
// local Responses provider. The injected policy probe isolates handover; run
// codex-update-smoke separately under AppArmor to verify the real policy gate.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile,cp,symlink,stat} from 'node:fs/promises';
import {spawn,execFileSync} from 'node:child_process';
import * as mgr from '/usr/local/share/codex-ha/codex-runtime-manager.mjs';
import {recordPackage,packageInventory} from '/usr/local/share/codex-ha/codex-package-integrity.mjs';
await mkdir('/config/.storage',{recursive:true});
await writeFile('/config/secrets.yaml','synthetic: test\n');
await mkdir('/data/codex',{recursive:true});
await writeFile('/data/options.json',JSON.stringify({codex_auto_update:true}));
let calls=0;
const provider=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  if(req.method!=='POST'){res.end('{"data":[]}');return;}
  calls++;
  if(calls===2)assert(body.includes('first-marker')&&body.includes('second-marker'));
  const events=[{type:'response.created',response:{id:`r${calls}`}},
    {type:'response.output_item.done',item:{type:'message',role:'assistant',id:`m${calls}`,content:[{type:'output_text',text:'synthetic answer'}]}},
    {type:'response.completed',response:{id:`r${calls}`,usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}];
  const data=events.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  res.writeHead(200,{'content-type':'text/event-stream'});res.end(data);
});
await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
await writeFile('/data/codex/config.toml',`model="synthetic-test"\nmodel_provider="synthetic"\n[model_providers.synthetic]\nname="Synthetic"\nbase_url="http://127.0.0.1:${provider.address().port}/v1"\nwire_api="responses"\nrequires_openai_auth=false\nrequest_max_retries=0\nstream_max_retries=0\n`);
await mgr.initRuntime();
const target='/data/codex-runtime/releases/0.165.0-x86_64-unknown-linux-musl';
await cp('/candidate',target,{recursive:true,verbatimSymlinks:true});
execFileSync('chown',['-R','0:0',target]);
execFileSync('chmod',['-R','go-w',target]);
await recordPackage(target,mgr.getBaseRuntimeDir(),'b'.repeat(64),await packageInventory(target));
await symlink(target,mgr.getStagedLink());
await mgr.updateState(s=>{s.stagedVersion='0.165.0';s.candidateVersion='0.165.0';s.candidateDigest='b'.repeat(64);});
const worker=spawn('/usr/local/bin/codex',['app-server'],{cwd:'/config',env:{PATH:process.env.PATH,HOME:'/data/home',CODEX_HOME:'/data/codex',LANG:'C.UTF-8'},stdio:['pipe','pipe','inherit']});
let buffer='',messages=[];
worker.stdout.on('data',chunk=>{buffer+=chunk;let idx;while((idx=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,idx);buffer=buffer.slice(idx+1);if(line.trim())messages.push(JSON.parse(line));}});
const send=obj=>worker.stdin.write(JSON.stringify(obj)+'\n');
async function until(predicate){const deadline=Date.now()+45000;while(Date.now()<deadline){const idx=messages.findIndex(predicate);if(idx>=0)return messages.splice(idx,1)[0];assert(worker.exitCode===null,'wrapper exited');await new Promise(r=>setTimeout(r,20));}throw Error('response_timeout');}
async function rpc(id,method,params={}){send({id,method,params});const msg=await until(x=>x.id===id);assert(!msg.error,JSON.stringify(msg.error));return msg.result;}
async function turn(id,thread,text){await rpc(id,'turn/start',{threadId:thread,input:[{type:'text',text}]});const done=await until(x=>x.method==='turn/completed');assert.equal(done.params.turn.status,'completed');}
try{
  await rpc(1,'initialize',{clientInfo:{name:'synthetic-test',version:'1'}});send({method:'initialized'});
  const thread=(await rpc(2,'thread/start',{cwd:'/config',model:'synthetic-test'})).thread.id;
  await turn(3,thread,'first-marker');
  const before=await mgr.inspectAllSessions();assert(before.canApply,JSON.stringify(before.busyReasons));
  const oldPid=before.restartableServers[0].managedRecord.workerPid;
  const applied=await mgr.applyUpdate({isManual:false,policyProbe:async()=>({valid:true})});assert(applied.applied,JSON.stringify(applied));
  const after=await mgr.inspectAllSessions();const newPid=after.restartableServers[0].managedRecord.workerPid;
  assert.notEqual(oldPid,newPid);assert.equal((await stat(`/proc/${newPid}/exe`)).ino,(await stat(target+'/bin/codex')).ino);
  await turn(4,thread,'second-marker');assert.equal(calls,2);
  console.log('PASS: image wrapper -> applyUpdate -> official new worker -> same conversation response');
}finally{
  worker.stdin.end();worker.kill('SIGTERM');
  await new Promise(resolve=>worker.exitCode!==null?resolve():worker.once('exit',resolve));
  provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));
}
