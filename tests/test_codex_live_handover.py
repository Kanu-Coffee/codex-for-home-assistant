"""Real official worker handover against a local, credential-free Responses fixture."""
import base64
import http.server
import json
import os
from pathlib import Path
import select
import socket
import struct
import subprocess
import shutil
import threading
import time
import pty
import fcntl
import termios

import pytest


@pytest.mark.skipif(not os.environ.get('CODEX_HANDOVER_BASELINE') or not os.environ.get('CODEX_HANDOVER_CANDIDATE'),
                    reason='official package pair not provided')
@pytest.mark.parametrize('transport', ['stdio', 'websocket', 'tui'])
def test_real_worker_handover(repository_root: Path, tmp_path: Path, transport: str):
    baseline = Path(os.environ['CODEX_HANDOVER_BASELINE']).resolve(strict=True)
    candidate = Path(os.environ['CODEX_HANDOVER_CANDIDATE']).resolve(strict=True)
    # Real immutable packages in the same layout used by the production updater.
    old_package = tmp_path/'baseline'
    shutil.copytree(baseline.parent.parent, old_package)
    runtime = tmp_path/'runtime'; maintenance = tmp_path/'maintenance'
    (maintenance/'sessions').mkdir(parents=True)
    new_package = runtime/'releases'/'0.165.0-x86_64-unknown-linux-musl'
    shutil.copytree(candidate.parent.parent, new_package)
    baseline = old_package/'bin/codex'; candidate = new_package/'bin/codex'
    options = tmp_path/'options.json'
    options.write_text(json.dumps({'codex_auto_update':True,'codex_update_timezone':'Asia/Seoul'}))
    manager_env = {**os.environ,'CODEX_RUNTIME_DIR':str(runtime),'CODEX_BASELINE_DIR':str(old_package),
                   'CODEX_MAINTENANCE_DIR':str(maintenance),'CODEX_HA_OPTIONS_FILE':str(options)}
    def manager(js):
        result = subprocess.run(['node','--input-type=module','-e',
            "import * as mgr from './codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-runtime-manager.mjs';"+js],
            cwd=repository_root,env=manager_env,capture_output=True,text=True,timeout=60,check=True)
        return json.loads(result.stdout.splitlines()[-1])
    manager("await mgr.initRuntime(); console.log('{}');")
    (runtime/'staged').symlink_to(new_package)
    manager(f"""const ledger = await import('./codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-package-integrity.mjs');
      await ledger.recordPackage({json.dumps(str(new_package))},mgr.getBaseRuntimeDir(),'b'.repeat(64),await ledger.packageInventory({json.dumps(str(new_package))}));
      await mgr.updateState(s=>{{s.stagedVersion='0.165.0';s.candidateVersion='0.165.0';s.candidateDigest='b'.repeat(64);}});
      console.log('{{}}');""")
    requests = []
    allow_response = threading.Event()
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass
        def do_POST(self):
            requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
            assert allow_response.wait(30), 'test response release timed out'
            events = [
                {'type':'response.created', 'response':{'id':f'response-{len(requests)}'}},
                {'type':'response.output_item.done', 'item':{'type':'message','role':'assistant',
                 'id':f'message-{len(requests)}','content':[{'type':'output_text','text':'synthetic answer'}]}},
                {'type':'response.completed','response':{'id':f'response-{len(requests)}',
                 'usage':{'input_tokens':1,'output_tokens':1,'total_tokens':2}}},
            ]
            body = ''.join('event: '+e['type']+'\ndata: '+json.dumps(e)+'\n\n' for e in events).encode()
            self.send_response(200); self.send_header('Content-Type','text/event-stream')
            self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
    provider = http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=provider.serve_forever,daemon=True).start()
    home = tmp_path/'home'; codex_home = home/'codex'; codex_home.mkdir(parents=True)
    (codex_home/'config.toml').write_text(f'''model="synthetic-test"
model_provider="synthetic"
[model_providers.synthetic]
name="Synthetic"
base_url="http://127.0.0.1:{provider.server_port}/v1"
wire_api="responses"
requires_openai_auth=false
request_max_retries=0
stream_max_retries=0
''')
    control_path = tmp_path/'ctl.sock'; client_path = tmp_path/'client.sock'
    host = repository_root/'codex_home_assistant/rootfs/usr/local/share/codex-ha/codex-session-host.mjs'
    command = ['node',str(host),'--control-socket',str(control_path),'--exe',str(baseline),'--version','0.162.1','--session-file',str(maintenance/'sessions'/'%PID%')]
    if transport == 'websocket':command += ['--client-socket',str(client_path),'--type','cli']
    if transport == 'tui':command += ['--client-socket',str(client_path),'--type','cli','--spawn-client','--client-args','[]']
    command += ['--','app-server']
    env = {'HOME':str(home),'CODEX_HOME':str(codex_home),'PATH':os.environ['PATH'],
           'LANG':'C.UTF-8','TERM':'xterm-256color','NO_PROXY':'127.0.0.1,localhost','HTTP_PROXY':'http://127.0.0.1:9','HTTPS_PROXY':'http://127.0.0.1:9'}
    log = (tmp_path/'worker.log').open('wb')
    master = slave = None
    if transport == 'tui':
        master,slave=pty.openpty()
        fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',28,100,0,0))
        relay = subprocess.Popen(command,stdin=slave,stdout=slave,stderr=slave,env=env,cwd=tmp_path,start_new_session=True)
        os.close(slave)
    else:
        relay = subprocess.Popen(command,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,env=env,cwd=tmp_path,bufsize=0)
    peer = None; buf = b''
    def control(obj):
        with socket.socket(socket.AF_UNIX) as s:
            s.settimeout(20); s.connect(str(control_path)); s.sendall(json.dumps(obj).encode()+b'\n')
            data=b''
            while b'\n' not in data:
                chunk=s.recv(65536); assert chunk, 'control EOF'; data+=chunk
            return json.loads(data.split(b'\n')[0])
    def read_exact(n):
        stream=peer if peer else relay.stdout; result=b''; deadline=time.monotonic()+20
        while len(result)<n:
            remain=deadline-time.monotonic()
            assert remain>0 and select.select([stream],[],[],remain)[0], 'client response timed out'
            part=peer.recv(n-len(result)) if peer else os.read(stream.fileno(),n-len(result))
            assert part,'client EOF';result+=part
        return result
    def send(obj):
        data=json.dumps(obj).encode()
        if peer:
            mask=os.urandom(4); n=len(data)
            header=bytes([0x81,0x80|n]) if n<126 else bytes([0x81,0xfe])+struct.pack('!H',n)
            peer.sendall(header+mask+bytes(v^mask[i%4] for i,v in enumerate(data)))
        else:relay.stdin.write(data+b'\n');relay.stdin.flush()
    def receive():
        nonlocal buf
        if peer:
            a,b=read_exact(2);n=b&127
            if n==126:n=struct.unpack('!H',read_exact(2))[0]
            elif n==127:n=struct.unpack('!Q',read_exact(8))[0]
            assert a==0x81 and n<32*1024*1024
            return json.loads(read_exact(n))
        while b'\n' not in buf:buf+=read_exact(1)
        line,buf=buf.split(b'\n',1);return json.loads(line)
    def result(req_id):
        for _ in range(1000):
            msg=receive()
            if msg.get('id')==req_id:
                assert 'error' not in msg,msg.get('error');return msg['result']
        raise AssertionError('response missing')
    def turn(req_id, thread_id, text):
        send({'id':req_id,'method':'turn/start','params':{'threadId':thread_id,'input':[{'type':'text','text':text}]}})
        result(req_id)
        if req_id == 3:
            blocked=manager("const r=await mgr.applyUpdate({isManual:false,policyProbe:async()=>({valid:true})});console.log(JSON.stringify({applied:r.applied,reason:r.reason}));")
            assert not blocked['applied'],blocked
            assert control({'cmd':'inspect'})['busy']
            allow_response.set()
        for _ in range(1000):
            message=receive()
            if message.get('method')=='turn/completed':
                assert message['params']['turn']['status']=='completed',message;return
        raise AssertionError('turn not completed')
    try:
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            if control_path.exists() and (transport=='stdio' or client_path.exists()):break
            assert relay.poll() is None;time.sleep(.05)
        if transport=='tui':
            allow_response.set()
            screen=bytearray()
            def read_screen(seconds):
                deadline=time.monotonic()+seconds
                while time.monotonic()<deadline:
                    if select.select([master],[],[],.05)[0]:
                        try:screen.extend(os.read(master,65536))
                        except OSError:break
            read_screen(2)
            os.write(master,b'first-marker');read_screen(.2);os.write(master,b'\r')
            def wait_answer(marker):
                for _ in range(150):
                    read_screen(.1)
                    assert relay.poll() is None,bytes(screen[-1500:])
                    if any(marker in json.dumps(r) for r in requests):
                        state=control({'cmd':'inspect'})
                        if not state['busy']:return state
                raise AssertionError(bytes(screen[-2000:]))
            before=wait_answer('first-marker')
            applied=manager("const r=await mgr.applyUpdate({isManual:false,policyProbe:async()=>({valid:true})});console.log(JSON.stringify({applied:r.applied,reason:r.reason,stateReason:r.state?.reason}));")
            assert applied['applied'],(applied,control({'cmd':'inspect'}))
            after=control({'cmd':'inspect'})
            assert after['workerPid']!=before['workerPid'] and after['version']=='0.165.0'
            read_screen(.5);os.write(master,b'second-marker');read_screen(.2);os.write(master,b'\r')
            wait_answer('second-marker')
            assert any('first-marker' in json.dumps(r) and 'second-marker' in json.dumps(r) for r in requests)
            return
        if transport=='websocket':
            peer=socket.socket(socket.AF_UNIX);peer.connect(str(client_path))
            key=base64.b64encode(os.urandom(16));peer.sendall(b'GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: '+key+b'\r\nSec-WebSocket-Version: 13\r\n\r\n')
            header=b''
            while not header.endswith(b'\r\n\r\n'):header+=read_exact(1)
            assert header.startswith(b'HTTP/1.1 101 ')
        send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'synthetic-test','version':'1'}}});result(1)
        send({'method':'initialized'})
        send({'id':2,'method':'thread/start','params':{'cwd':str(tmp_path),'model':'synthetic-test'}})
        thread=result(2)['thread']['id']
        turn(3,thread,'first-marker')
        before=control({'cmd':'inspect'});assert not before['busy'],before
        applied=manager("const r=await mgr.applyUpdate({isManual:false,policyProbe:async()=>({valid:true})});console.log(JSON.stringify({applied:r.applied,reason:r.reason,stateReason:r.state?.reason}));")
        assert applied.get('applied'),(applied,control({'cmd':'inspect'}))
        switched=control({'cmd':'inspect'})
        assert switched.get('version')=='0.165.0',switched
        assert switched['workerPid']!=before['workerPid']
        assert os.stat(f"/proc/{switched['workerPid']}/exe").st_ino==candidate.stat().st_ino
        turn(4,thread,'second-marker')
        assert len(requests)==2
        assert 'first-marker' in json.dumps(requests[1]) and 'second-marker' in json.dumps(requests[1])
    finally:
        allow_response.set()
        if peer:peer.close()
        if relay.poll() is None:relay.terminate()
        try:relay.wait(timeout=10)
        except subprocess.TimeoutExpired:relay.kill();relay.wait()
        if master is not None:os.close(master)
        log.close();provider.shutdown();provider.server_close()
