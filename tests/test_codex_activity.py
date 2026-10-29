"""Activity observation must distinguish loaded state from unfinished work."""
import json
import subprocess
from pathlib import Path

import pytest


@pytest.mark.parametrize('case,expected', [
    ('idle', 'idle'), ('active', 'busy'), ('queued', 'busy'),
    ('approval', 'busy'), ('background', 'busy'), ('late_page', 'busy'),
    ('missing', 'unknown'), ('duplicate', 'unknown'), ('negative', 'unknown'),
    ('bad_status', 'unknown'), ('wrong_pid', 'unknown'), ('loop', 'unknown'),
    ('rpc_error', 'unknown'), ('wrong_thread', 'unknown'),
])
def test_activity_observation(repository_root: Path, case: str, expected: str):
    script = r'''
    import { observeActivity } from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-activity.mjs';
    const scenario = CASE;
    const gauges = ['app.requests.in_flight','app.requests.queued','app.server_requests.pending','core.turns.active']
      .map((name,i)=>({name,value:i===0?1:0}));
    if(scenario==='queued') gauges[1].value=1;
    if(scenario==='approval') gauges[2].value=1;
    if(scenario==='missing') gauges.pop();
    if(scenario==='negative') gauges[1].value=-1;
    if(scenario==='duplicate') gauges.push(gauges[0]);
    const client={call:async(method,params)=>{
      if(scenario==='rpc_error') throw Error('PRIVATE_PAYLOAD');
      if(method==='server/diagnostics')return {process:{id:scenario==='wrong_pid'?43:42},gauges};
      if(method==='thread/loaded/list') {
        if(scenario==='loop')return {data:[],nextCursor:'repeated'};
        if(scenario==='late_page'&&!params.cursor)return {data:['first'],nextCursor:'second'};
        return {data:[params.cursor?'last':'first'],nextCursor:null};
      }
      if(method==='thread/read')return {thread:{id:scenario==='wrong_thread'?'wrong':params.threadId,
        status:{type:scenario==='bad_status'?'unrecognized':
          scenario==='active'||(scenario==='late_page'&&params.threadId==='last')?'active':'idle'}}};
      if(method==='thread/backgroundTerminals/list')return {data:scenario==='background'?[{command:'PRIVATE_PAYLOAD'}]:[]};
      throw Error('unexpected_method');
    }};
    console.log(JSON.stringify(await observeActivity(client,42)));
    '''.replace('CASE', json.dumps(case))
    proc = subprocess.run(['node', '--input-type=module', '-e', script],
                          cwd=repository_root, capture_output=True, text=True, check=True)
    result = json.loads(proc.stdout)
    assert result['activity'] == expected
    assert result['complete'] is (expected != 'unknown')
    assert 'PRIVATE_PAYLOAD' not in proc.stdout


def test_completed_commands_and_processes_release_activity(repository_root: Path):
    script = r'''
    import {StdioRelay} from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs';
    const relay=new StdioRelay({childExe:process.execPath});
    relay.child={pid:process.pid,exitCode:null,signalCode:null,stdin:{writable:true,write:()=>true}};
    const request=obj=>relay._handleClientData(JSON.stringify(obj)+'\n');
    const response=obj=>relay._handleServerData(JSON.stringify(obj)+'\n');
    request({id:1,method:'command/exec',params:{command:'synthetic'}});
    const commandRunning=relay._workState().busy;
    response({id:1,result:{exitCode:0,stdout:'',stderr:''}});
    const commandDone=!relay._workState().busy;
    request({id:2,method:'process/spawn',params:{processHandle:'synthetic-handle'}});
    response({id:2,result:{}});
    const processRunning=relay._workState().busy;
    response({method:'process/exited',params:{processHandle:'synthetic-handle',exitCode:0}});
    const processDone=!relay._workState().busy;
    response({id:5,method:'item/commandExecution/requestApproval',params:{}});
    const approvalWaiting=relay._workState().busy;
    response({method:'serverRequest/resolved',params:{requestId:5}});
    const approvalDone=!relay._workState().busy;
    response({method:'thread/goal/updated',params:{threadId:'synthetic',goal:{status:'active'}}});
    const goalRunning=relay._workState().busy;
    response({method:'thread/goal/cleared',params:{threadId:'synthetic'}});
    const goalCleared=!relay._workState().busy;
    response({method:'thread/goal/updated',params:{threadId:'synthetic',goal:{status:'budgetLimited'}}});
    const goalLimited=!relay._workState().busy;
    console.log(JSON.stringify({commandRunning,commandDone,processRunning,processDone,approvalWaiting,approvalDone,goalRunning,goalCleared,goalLimited}));
    '''
    proc=subprocess.run(['node','--input-type=module','-e',script],cwd=repository_root,
                        capture_output=True,text=True,check=True)
    assert all(json.loads(proc.stdout.splitlines()[-1]).values())
