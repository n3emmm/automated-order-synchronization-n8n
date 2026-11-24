"""Run the released workflow on actual n8n CLI in a fresh SQLite profile."""
import json, os, re, subprocess, sys, tempfile, threading
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from mock import Lab
lab=Lab()
threading.Thread(target=lab.serve_forever,daemon=True).start()
try:
    with tempfile.TemporaryDirectory(dir=os.environ.get('LAB_TMP')) as home:
        env=dict(os.environ,HOME=home,N8N_USER_FOLDER=home,DB_TYPE='sqlite',N8N_DIAGNOSTICS_ENABLED='false',N8N_RUNNERS_BROKER_PORT='15789',N8N_PORT='15678')
        def cmd(*args):
            return subprocess.run([os.environ.get('N8N_BIN','n8n'),*args],env=env,cwd=home,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=240,check=True).stdout
        w=Path(home)/'workflow.json'
        w.write_bytes((ROOT/'workflow.json').read_bytes())
        print('version',cmd('--version').strip(),flush=True)
        cmd('import:workflow','--input='+str(w))
        def run():
            lab.calls.clear()
            raw=cmd('execute','--id=OrderSyncLocalV1','--rawOutput')
            pos=re.search(r'(?m)^\{\s*"data"\s*:',raw)
            assert pos,raw[-2000:]
            result=json.JSONDecoder().raw_decode(raw[pos.start():])[0]['data']['resultData']
            report=result['runData']['Run report'][-1]['data']['main'][0][0]['json']
            print(report,flush=True)
            return report
        lab.faults['page']=[429]
        lab.faults['write']=['drop_after_commit']
        a=run()
        assert (a['added'],a['failed'],a['pages'],a['status'])==(250,0,5,'complete')
        assert len(lab.rows)==251 and lab.calls[1][1]-lab.calls[0][1]>=1.95
        assert sum(op=='write' for op,t in lab.calls)==7
        b=run()
        assert b['skipped']==250 and not any(op=='write' for op,t in lab.calls)
        lab.orders[0]['status']='shipped'
        lab.orders.append({'order_id':'bad'})
        lab.faults['write']=[503]*3
        c=run()
        assert c['failed']==2 and c['skipped']==249 and c['status']=='partial'
        assert sum(op=='write' for op,t in lab.calls)==3
        d=run()
        assert d['updated']==1 and d['failed']==1 and lab.rows[1][1]=='shipped' and len(lab.rows)==251
        lab.faults['page']=[403]
        e=run()
        assert e['fatal']=='authentication_403' and len(lab.calls)==1
        print('PASS 5 actual n8n executions',flush=True)
finally:
    lab.shutdown()
    lab.server_close()
