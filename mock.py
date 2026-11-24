"""Loopback REST store and Google Sheets values API double, standard library only."""
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent
HEADER = ['order_id', 'status', 'total_minor', 'currency', 'updated_at']
SHEET = '/v4/spreadsheets/mock/values'

class Lab(ThreadingHTTPServer):
    def __init__(self, port=18765):
        super().__init__(('127.0.0.1', port), Handler)
        self.orders = json.loads((ROOT/'fixtures/orders.json').read_text())
        self.rows = [HEADER.copy()]
        self.faults = {'page': [], 'index': [], 'write': []}
        self.calls = []
        self.lock = threading.Lock()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def reply(self, status, value, headers=None):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        for key,val in (headers or {}).items():
            self.send_header(key,val)
        self.end_headers()
        self.wfile.write(data)

    def handle_api(self):
        import time
        lab = self.server
        url = urlsplit(self.path)
        op = {('GET','/orders'):'page',('GET',SHEET+'/Orders!A1:E'):'index',
              ('POST',SHEET+':batchUpdate'):'write'}.get((self.command,url.path))
        if not op:
            return self.reply(404,{})
        with lab.lock:
            lab.calls.append((op,time.monotonic()))
            fault = lab.faults[op].pop(0) if lab.faults[op] else None
            if isinstance(fault,int):
                return self.reply(fault,{}, {'Retry-After':'2'} if fault==429 else {})
            if op=='page':
                query = parse_qs(url.query)
                try:
                    offset=int(query.get('cursor',['0'])[0])
                    limit=int(query.get('limit',['50'])[0])
                    if offset<0 or not 1<=limit<=100: raise ValueError()
                except ValueError:
                    return self.reply(400,{})
                end = offset+limit
                return self.reply(200,dict(orders=lab.orders[offset:end],
                     next_cursor=str(end) if end<len(lab.orders) else None))
            if op=='index':
                return self.reply(200,{'values':lab.rows})
            try:
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                assert body['valueInputOption']=='RAW'
                updates=[]
                for entry in body['data']:
                    match=re.fullmatch(r'Orders!A(\d+):E\1',entry['range'])
                    assert match and int(match[1])>=2
                    row,=entry['values']
                    assert len(row)==5 and all(isinstance(x,str) for x in row)
                    updates.append((int(match[1]),row))
            except (ValueError,TypeError,KeyError,AssertionError):
                return self.reply(400,{})
            for n,row in updates:
                while len(lab.rows)<n: lab.rows.append([])
                lab.rows[n-1]=row
            if fault=='drop_after_commit':
                self.close_connection=True
                return
            return self.reply(200,{} if fault=='short_ack' else {'totalUpdatedRows':len(updates)})

    do_GET=handle_api
    do_POST=handle_api

if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser()
    p.add_argument('--page-fault',type=int,action='append',default=[])
    p.add_argument('--write-fault',choices=['drop_after_commit','short_ack','503','400'],action='append',default=[])
    args=p.parse_args()
    lab=Lab()
    lab.faults['page']=args.page_fault
    lab.faults['write']=[int(x) if x.isdigit() else x for x in args.write_fault]
    print('Mock listening on 127.0.0.1:18765',flush=True)
    lab.serve_forever()
