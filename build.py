import json, uuid
from pathlib import Path
root=Path(__file__).resolve().parent
nodes=[]; connections={}
def node(name, kind, ver, x,y,p, **extra):
    nodes.append(dict(name=name,id=str(uuid.uuid5(uuid.NAMESPACE_URL,'order-sync/'+name)),type='n8n-nodes-base.'+kind,typeVersion=ver,position=[x,y],parameters=p,**extra))
def wire(a,*bs):
    connections[a]={'main':[[dict(node=b,type='main',index=0)] for b in bs]}
node('Manual','manualTrigger',1,0,0,{})
node('Daily (disabled)','scheduleTrigger',1.2,0,180,{'rule':{'interval':[{'field':'days','triggerAtHour':9}]}},disabled=True)
init="""return [{json:{
  source:'http://127.0.0.1:18765/orders',
  sheet:'http://127.0.0.1:18765/v4/spreadsheets/mock',
  op:'page',cursor:'',seen:[],pages:0,maxPages:100,orders:{},queue:[],batch:[],
  attempt:1,delay:0,duplicates:0,events:[],errors:[],counts:{added:0,updated:0,skipped:0}
}}];"""
node('Configuration','code',2,210,0,{'jsCode':init})
node('Dispatch','switch',3.2,430,0,{'mode':'expression','numberOutputs':5,'output':"={{ ['page','index','verify','write','done'].indexOf($json.op) }}"})
def http(name,y,url,write=False):
    p=dict(method='POST' if write else 'GET',url='={{ '+url+' }}',options={'timeout':15000,'redirect':{'redirect':{'followRedirects':False}},'response':{'response':{'fullResponse':True,'neverError':True,'responseFormat':'text'}}})
    if write:p.update(sendBody=True,specifyBody='json',jsonBody="""={{ {valueInputOption:'RAW',data:$json.batch.map(e=>({range:'Orders!A'+e.row+':E'+e.row,values:[e.values]}))} }}""")
    node(name,'httpRequest',4.2,700,y,p,onError='continueRegularOutput')
http('Fetch page',-180,"$json.source+'?limit=50&cursor='+encodeURIComponent($json.cursor)")
http('Read Orders',0,"$json.sheet+'/values/Orders!A1:E?valueRenderOption=UNFORMATTED_VALUE'")
http('Write fixed rows',180,"$json.sheet+'/values:batchUpdate'",True)
code=(root/'src/sync.js').read_text()+"""
const s = JSON.parse(JSON.stringify($('Dispatch').item.json));
const r = {...$json};
r.body = r.body ?? r.data;
if(typeof r.body === 'string') { try { r.body=JSON.parse(r.body); } catch { r.body=null; } }
return [{json:transition(s,r),pairedItem:{item:0}}];"""
node('Apply response','code',2,920,0,{'jsCode':code})
node('Delay needed','switch',3.2,1130,0,{'mode':'expression','numberOutputs':2,'output':'={{ $json.delay > 0 && $json.op !== "done" ? 1 : 0 }}'})
node('Backoff','wait',1.1,1130,205,{'amount':'={{ $json.delay }}','unit':'seconds'},webhookId=str(uuid.uuid5(uuid.NAMESPACE_URL,'orders-wait')))
node('Run report','code',2,700,365,{'jsCode':"""const s=$json;
return [{json:{status:s.fatal?'aborted':s.errors.length?'partial':'complete',...s.counts,failed:s.errors.length,pages:s.pages,duplicateInputs:s.duplicates,fatal:s.fatal||null,errors:s.errors,events:s.events}}];"""})
for a in ['Manual','Daily (disabled)']:wire(a,'Configuration')
wire('Configuration','Dispatch');wire('Dispatch','Fetch page','Read Orders','Read Orders','Write fixed rows','Run report')
for a in ['Fetch page','Read Orders','Write fixed rows']:wire(a,'Apply response')
wire('Apply response','Delay needed');wire('Delay needed','Dispatch','Backoff');wire('Backoff','Dispatch')
(root/'workflow.json').write_text(json.dumps(dict(id='OrderSyncLocalV1',name='Automated Order Synchronization System',active=False,nodes=nodes,connections=connections,settings={'executionOrder':'v1','timezone':'Asia/Amman','saveDataSuccessExecution':'all'}),indent=2)+'\n')
